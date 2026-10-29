import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted, Stream } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { InvalidResponse, TimedOut } from "./api-errors.ts";
import { makeApiClient } from "./api-client.ts";
import { compileOpenApi } from "./openapi.ts";
import { findOperation } from "./test-fixtures.ts";
import { CORPUS, readFixture } from "../scripts/corpus.ts";
import { parseOpenApi } from "./catalog.ts";
import { readBoundedBytes } from "./bounded-bytes.ts";

const operation = (
  responses: Record<string, unknown> = {
    "200": { content: { "application/pdf": {} } },
  },
) =>
  findOperation(
    compileOpenApi({
      openapi: "3.1.0",
      servers: [{ url: "https://files.example.com" }],
      paths: { "/download": { get: { operationId: "download", responses } } },
    }),
    "download",
  );
const responseClient = (
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array<ArrayBuffer>>,
  headers: Record<string, string> = { "Content-Type": "application/pdf" },
  status = 200,
) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, headers }),
      ),
    ),
  );

describe("Bounded binary responses", () => {
  it.effect(
    "collects tiny and empty chunks without retaining a chunk list",
    () =>
      Effect.gen(function* () {
        const expected = Uint8Array.from(
          { length: 20_000 },
          (_, index) => index % 256,
        );
        const chunks = function* () {
          for (const byte of expected) {
            yield new Uint8Array();
            yield new Uint8Array([byte]);
          }
        };
        const source = Stream.fromIterable(chunks());
        expect(yield* readBoundedBytes(source, expected.length)).toEqual(
          Buffer.from(expected),
        );
      }),
  );
  it.effect(
    "executes the pinned Stripe quote PDF on its declared file server",
    () =>
      Effect.gen(function* () {
        const source = CORPUS.find(
          (source) => source.file === "stripe.json.gz",
        );
        if (source === undefined) throw new Error("Missing Stripe fixture.");
        const fixture = yield* readFixture(source);
        const catalog = compileOpenApi(parseOpenApi(fixture.text), {
          parameterProfile: "brackets-indexed",
          credentials: { bearerAuth: Redacted.make("fixture-key") },
        });
        const selected = catalog.operations.find(
          (operation) => operation.path === "/v1/quotes/{quote}/pdf",
        );
        if (selected === undefined)
          throw new Error("Missing quote PDF operation.");
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            expect(request.url).toBe(
              "https://files.stripe.com/v1/quotes/qt_fixture/pdf",
            );
            expect(request.method).toBe("GET");
            expect(request.body._tag).toBe("Empty");
            expect(request.headers.authorization).toBe("Bearer fixture-key");
            expect(request.headers.accept).toContain("application/pdf");
            return HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array([37, 80, 68, 70, 255]), {
                headers: { "Content-Type": "application/pdf" },
              }),
            );
          }),
        );
        expect(
          yield* makeApiClient(http).execute(selected, {
            path: { quote: "qt_fixture" },
          }),
        ).toEqual({ mimeType: "application/pdf", dataBase64: "JVBERv8=" });
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  it.effect.each(["application/pdf", "application/octet-stream"])(
    "preserves every byte for %s at the exact limit",
    (mimeType) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
        const selected = operation({ "200": { content: { [mimeType]: {} } } });
        const result = yield* makeApiClient(
          responseClient(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.slice(0, 3));
                controller.enqueue(bytes.slice(3));
                controller.close();
              },
            }),
            { "Content-Type": mimeType.toUpperCase() },
          ),
          10_000,
          bytes.length,
        ).execute(selected, {});
        expect(result).toEqual({
          mimeType,
          dataBase64: Buffer.from(bytes).toString("base64"),
        });
      }),
  );
  it.effect(
    "returns an empty binary representation without inventing text",
    () =>
      Effect.gen(function* () {
        expect(
          yield* makeApiClient(responseClient(new Uint8Array())).execute(
            operation(),
            {},
          ),
        ).toEqual({ mimeType: "application/pdf", dataBase64: "" });
      }),
  );
  it.effect(
    "counts actual bytes rather than Content-Length and cancels overflow",
    () =>
      Effect.gen(function* () {
        let cancelled = false;
        const http = responseClient(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0, 255, 1]));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { "Content-Type": "application/pdf", "Content-Length": "1" },
        );
        const failure = yield* Effect.flip(
          makeApiClient(http, 10_000, 2).execute(operation(), {}),
        );
        expect(failure).toBeInstanceOf(InvalidResponse);
        expect(failure.message).toBe(
          "The API response exceeded the configured byte limit.",
        );
        expect(cancelled).toBe(true);
      }),
  );
  it.effect(
    "allocates a new collection and byte budget for each execution",
    () =>
      Effect.gen(function* () {
        const http = HttpClient.make((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array([0, 255]), {
                headers: { "Content-Type": "application/pdf" },
              }),
            ),
          ),
        );
        const program = makeApiClient(http, 10_000, 2).execute(operation(), {});
        expect(
          yield* Effect.all([program, program], { concurrency: "unbounded" }),
        ).toEqual([
          { mimeType: "application/pdf", dataBase64: "AP8=" },
          { mimeType: "application/pdf", dataBase64: "AP8=" },
        ]);
        expect(yield* program).toEqual({
          mimeType: "application/pdf",
          dataBase64: "AP8=",
        });
      }),
  );
  it.effect.each([
    undefined,
    "application/octet-stream",
    "text/plain",
    "application/json",
    "application/pdf; charset=utf-8",
    "multipart/mixed",
  ])("rejects undeclared or unsupported media (%s)", (contentType) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        makeApiClient(
          responseClient(
            new Uint8Array([255]),
            contentType === undefined ? {} : { "Content-Type": contentType },
          ),
        ).execute(operation(), {}),
      );
      expect(failure).toBeInstanceOf(InvalidResponse);
      expect(failure.message).toBe(
        "The API returned an unsupported response media type.",
      );
    }),
  );
  it.effect(
    "selects media by status, including range and default declarations",
    () =>
      Effect.gen(function* () {
        const selected = operation({
          "200": { content: { "application/pdf": {} } },
          "2XX": { content: { "application/octet-stream": {} } },
        });
        const failure = yield* Effect.flip(
          makeApiClient(
            responseClient(
              new Uint8Array(),
              { "Content-Type": "application/pdf" },
              201,
            ),
          ).execute(selected, {}),
        );
        expect(failure).toBeInstanceOf(InvalidResponse);
        expect(
          yield* makeApiClient(
            responseClient(
              new Uint8Array(),
              { "Content-Type": "application/octet-stream" },
              201,
            ),
          ).execute(selected, {}),
        ).toEqual({ mimeType: "application/octet-stream", dataBase64: "" });
        expect(
          yield* makeApiClient(
            responseClient(
              new Uint8Array(),
              { "Content-Type": "application/pdf" },
              203,
            ),
          ).execute(
            operation({ default: { content: { "application/pdf": {} } } }),
            {},
          ),
        ).toEqual({ mimeType: "application/pdf", dataBase64: "" });
      }),
  );
  it.effect("sanitizes binary stream failures", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        makeApiClient(
          responseClient(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("private upstream detail"));
              },
            }),
          ),
        ).execute(operation(), {}),
      );
      expect(failure).toBeInstanceOf(InvalidResponse);
      expect(JSON.stringify(failure)).not.toContain("private upstream detail");
    }),
  );
  it.effect("times out and cancels an unfinished binary response", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let cancelled = false;
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([0]));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "Content-Type": "application/pdf" } },
            ),
          );
        }),
      );
      const fiber = yield* Effect.forkChild(
        Effect.flip(makeApiClient(http, 10).execute(operation(), {})),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(11);
      expect(yield* Fiber.join(fiber)).toBeInstanceOf(TimedOut);
      expect(cancelled).toBe(true);
    }),
  );
  it("continues preferring JSON and text over a binary alternative", () => {
    const json = operation({
      "200": { content: { "application/pdf": {}, "application/json": {} } },
    });
    const text = operation({
      "200": { content: { "application/pdf": {}, "text/plain": {} } },
    });
    expect(json.responses).toEqual({ "200": "json" });
    expect(json.responseContentTypes).toEqual(["application/json"]);
    expect(text.responses).toEqual({ "200": "text" });
    expect(text.responseContentTypes).toEqual(["text/plain"]);
  });
});
