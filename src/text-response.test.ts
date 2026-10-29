import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { InvalidArguments, InvalidResponse, TimedOut } from "./api-errors.ts";
import { makeApiClient } from "./api-client.ts";
import { compileOpenApi } from "./openapi.ts";
import { findOperation } from "./test-fixtures.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const operation = (
  responses: Record<string, unknown> = {
    "200": { content: { "text/plain": { schema: { type: "string" } } } },
  },
) =>
  findOperation(
    compileOpenApi({
      openapi: "3.2.1",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/text": {
          post: {
            operationId: "text",
            requestBody: {
              content: { "text/plain": { schema: { type: "string" } } },
            },
            responses,
          },
        },
      },
    }),
    "text",
  );
const responseClient = (
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array<ArrayBuffer>>,
  headers: Record<string, string> = { "Content-Type": "text/plain" },
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

describe("Bounded native text execution", () => {
  it.effect(
    "preserves empty text, UTF-8, line endings and the initial BOM",
    () =>
      Effect.gen(function* () {
        for (const text of ["", "Café +\r\n😀", "\uFEFFCafé\r\n"])
          expect(
            yield* makeApiClient(responseClient(bytes(text))).execute(
              operation(),
              {},
            ),
          ).toBe(text);
      }),
  );
  it.effect("accepts split multibyte text at the exact byte limit", () =>
    Effect.gen(function* () {
      const value = "aé😀";
      const encoded = bytes(value);
      const http = responseClient(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoded.slice(0, 2));
            controller.enqueue(encoded.slice(2, 5));
            controller.enqueue(encoded.slice(5));
            controller.close();
          },
        }),
      );
      expect(
        yield* makeApiClient(http, 10_000, encoded.length).execute(
          operation(),
          {},
        ),
      ).toBe(value);
    }),
  );
  it.effect(
    "allocates a fresh UTF-8 decoder and byte budget for each evaluation",
    () =>
      Effect.gen(function* () {
        const program = makeApiClient(
          responseClient(bytes("é")),
          10_000,
          2,
        ).execute(operation(), {});
        expect(
          yield* Effect.all([program, program], { concurrency: "unbounded" }),
        ).toEqual(["é", "é"]);
        expect(yield* program).toBe("é");
      }),
  );
  it.effect.each(["é", "😀"])(
    "counts received bytes and cancels oversized text (%s)",
    (text) =>
      Effect.gen(function* () {
        let cancelled = false;
        const encoded = bytes(text);
        const http = responseClient(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoded);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { "Content-Type": "text/plain", "Content-Length": "1" },
        );
        const failure = yield* Effect.flip(
          makeApiClient(http, 10_000, encoded.length - 1).execute(
            operation(),
            {},
          ),
        );
        expect(failure).toBeInstanceOf(InvalidResponse);
        expect(failure.message).toBe(
          "The API response exceeded the configured byte limit.",
        );
        expect(cancelled).toBe(true);
      }),
  );
  it.effect(
    "rejects malformed UTF-8 and cancels the remaining text stream",
    () =>
      Effect.gen(function* () {
        let cancelled = false;
        const http = responseClient(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0xff]));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
        const failure = yield* Effect.flip(
          makeApiClient(http).execute(operation(), {}),
        );
        expect(failure).toBeInstanceOf(InvalidResponse);
        expect(failure.message).toBe("The API returned invalid UTF-8.");
        expect(cancelled).toBe(true);
      }),
  );
  it.effect(
    "flushes the decoder and rejects a truncated final UTF-8 character",
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          makeApiClient(responseClient(new Uint8Array([0xc3]))).execute(
            operation(),
            {},
          ),
        );
        expect(failure).toBeInstanceOf(InvalidResponse);
        expect(failure.message).toBe("The API returned invalid UTF-8.");
      }),
  );
  it.effect.each([
    "text/plain",
    "TEXT/PLAIN; Charset=UTF-8",
    'text/plain; charset="utf8"',
  ])(
    "accepts the declared text essence and supported charset (%s)",
    (contentType) =>
      Effect.gen(function* () {
        expect(
          yield* makeApiClient(
            responseClient(bytes("ok"), { "Content-Type": contentType }),
          ).execute(operation(), {}),
        ).toBe("ok");
      }),
  );
  it.effect.each([
    undefined,
    "text/html",
    "text/csv",
    "text/event-stream",
    "application/json",
    "application/octet-stream",
    "text/plain; charset=iso-8859-1",
    "text/plain; charset=us-ascii",
  ])(
    "rejects absent, undeclared or unsupported text response media (%s)",
    (contentType) =>
      Effect.gen(function* () {
        const headers: Record<string, string> =
          contentType === undefined ? {} : { "Content-Type": contentType };
        const failure = yield* Effect.flip(
          makeApiClient(
            responseClient(bytes("upstream-private-body"), headers),
          ).execute(operation(), {}),
        );
        expect(failure).toBeInstanceOf(InvalidResponse);
        expect(failure.message).toBe(
          "The API returned an unsupported response media type.",
        );
        expect(JSON.stringify(failure)).not.toContain("upstream-private-body");
      }),
  );
  it.effect(
    "matches textual media to the selected status rather than another response",
    () =>
      Effect.gen(function* () {
        const selected = operation({
          "200": { content: { "text/plain": {} } },
          "201": { content: { "text/html": {} } },
          "2XX": { content: { "text/csv": {} } },
          default: { content: { "text/markdown": {} } },
        });
        for (const [status, contentType] of [
          [200, "text/plain"],
          [201, "text/html"],
          [202, "text/csv"],
          [203, "text/csv"],
        ] as const)
          expect(
            yield* makeApiClient(
              responseClient(
                bytes("ok"),
                { "Content-Type": contentType },
                status,
              ),
            ).execute(selected, {}),
          ).toBe("ok");
        const wrongStatus = yield* Effect.flip(
          makeApiClient(
            responseClient(
              bytes("wrong"),
              { "Content-Type": "text/plain" },
              201,
            ),
          ).execute(selected, {}),
        );
        expect(wrongStatus).toBeInstanceOf(InvalidResponse);
        const fallback = operation({
          default: { content: { "text/markdown": {} } },
        });
        expect(
          yield* makeApiClient(
            responseClient(
              bytes("# heading"),
              { "Content-Type": "text/markdown" },
              203,
            ),
          ).execute(fallback, {}),
        ).toBe("# heading");
      }),
  );
  it.effect("rejects text for an undeclared successful status", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        makeApiClient(
          responseClient(
            bytes("undeclared"),
            { "Content-Type": "text/plain" },
            201,
          ),
        ).execute(operation(), {}),
      );
      expect(failure).toBeInstanceOf(InvalidResponse);
    }),
  );
  it.effect(
    "prefers JSON when the response also declares text and preserves JSON BOM handling",
    () =>
      Effect.gen(function* () {
        const selected = operation({
          "200": { content: { "text/plain": {}, "application/json": {} } },
        });
        const http = HttpClient.make((request) => {
          expect(request.headers.accept).toBe("application/json");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(bytes('\uFEFF{"ok":true}'), {
                headers: { "Content-Type": "application/json" },
              }),
            ),
          );
        });
        expect(yield* makeApiClient(http).execute(selected, {})).toEqual({
          ok: true,
        });
        expect(
          yield* Effect.flip(
            makeApiClient(responseClient(bytes("plain"))).execute(selected, {}),
          ),
        ).toBeInstanceOf(InvalidResponse);
      }),
  );
  it.effect(
    "rejects nonstrings and malformed Unicode before sending a text request",
    () =>
      Effect.gen(function* () {
        const api = makeApiClient(
          HttpClient.make(() => Effect.die("Invalid text must not dispatch")),
        );
        for (const body of [null, 0, false, {}, [], "\ud800", "\udc00"])
          expect(
            yield* Effect.flip(api.execute(operation(), { body })),
          ).toBeInstanceOf(InvalidArguments);
      }),
  );
  it.effect(
    "counts text request UTF-8 bytes and accepts the exact request limit",
    () =>
      Effect.gen(function* () {
        let requests = 0;
        const http = HttpClient.make((request) => {
          requests++;
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag !== "Uint8Array")
            return Effect.die("Expected native text request bytes");
          expect([...request.body.body]).toEqual([0xc3, 0xa9]);
          expect(request.headers["content-type"]).toBe("text/plain");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("ok", { headers: { "Content-Type": "text/plain" } }),
            ),
          );
        });
        const api = makeApiClient(http, 10_000, 1024, 2);
        expect(yield* api.execute(operation(), { body: "é" })).toBe("ok");
        expect(
          yield* Effect.flip(api.execute(operation(), { body: "😀" })),
        ).toBeInstanceOf(InvalidArguments);
        expect(requests).toBe(1);
      }),
  );
  it.effect("times out while reading text and cancels the upstream body", () =>
    Effect.gen(function* () {
      let cancelled = false;
      let signal: AbortSignal | undefined;
      const started = Deferred.makeUnsafe<void>();
      const http = HttpClient.make((request, _url, abortSignal) => {
        signal = abortSignal;
        return Deferred.succeed(started, undefined).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(bytes("partial"));
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
                { headers: { "Content-Type": "text/plain" } },
              ),
            ),
          ),
        );
      });
      const request = yield* makeApiClient(http)
        .execute(operation(), {})
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(request)).toBeInstanceOf(TimedOut);
      expect(cancelled).toBe(true);
      expect(signal?.aborted).toBe(true);
    }),
  );
});
