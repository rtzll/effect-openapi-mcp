import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Redacted,
  Tracer,
} from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";
import { makeApiClient } from "./api-client.ts";
import {
  ApiRejected,
  NetworkFailure,
  RateLimited,
  InvalidResponse,
} from "./api-errors.ts";
import { compileOpenApi } from "./openapi.ts";

const TEST_OPERATION = compileOpenApi({
  openapi: "3.1.0",
  servers: [{ url: "https://inventory.example.com/v1/" }],
  paths: {
    "/items": {
      get: { responses: { "200": { content: { "application/json": {} } } } },
    },
  },
}).operations[0];
if (TEST_OPERATION === undefined) {
  throw new Error("Missing test operation");
}
const responseClient = (status: number, headers: Record<string, string> = {}) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response('{"private":"upstream-secret"}', {
          status,
          headers: { "Content-Type": "application/json", ...headers },
        }),
      ),
    ),
  );

describe("Effect HTTP execution", () => {
  it.effect.each(["/documents:search", "/v1:batchGet", "/documents/search"])(
    "appends action path %s to the API base URL",
    (path) =>
      Effect.gen(function* () {
        const operation = compileOpenApi({
          openapi: "3.1.2",
          servers: [{ url: "https://inventory.example.com/api/v1/" }],
          paths: { [path]: { post: { responses: { "204": {} } } } },
        }).operations[0];
        if (operation === undefined) throw new Error("Missing test operation");
        const requested: string[] = [];
        const http = HttpClient.make((request) => {
          requested.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 204 }),
            ),
          );
        });
        expect(yield* makeApiClient(http).execute(operation, {})).toBeNull();
        expect(requested).toEqual([
          `https://inventory.example.com/api/v1${path}`,
        ]);
      }),
  );

  it.effect.each([401, 403, 422, 503])(
    "retains status %i as a typed rejection",
    (status) =>
      Effect.gen(function* () {
        const api = makeApiClient(responseClient(status));
        const failure = yield* Effect.flip(api.execute(TEST_OPERATION, {}));
        expect(failure).toBeInstanceOf(ApiRejected);
        expect(failure).toHaveProperty("status", status);
        expect(JSON.stringify(failure)).not.toContain("upstream-secret");
      }),
  );

  it.effect.each([undefined, "5", "Wed, 21 Oct 2026 07:28:00 GMT"])(
    "retains rate-limit retry metadata (%s)",
    (retryAfter) =>
      Effect.gen(function* () {
        const headers: Record<string, string> =
          retryAfter === undefined ? {} : { "Retry-After": retryAfter };
        const api = makeApiClient(responseClient(429, headers));
        const failure = yield* Effect.flip(api.execute(TEST_OPERATION, {}));
        expect(failure).toBeInstanceOf(RateLimited);
        expect(failure).toHaveProperty(
          "retryAfter",
          Option.fromUndefinedOr(retryAfter),
        );
      }),
  );

  it.effect("keeps transport failures distinct and scrubs their causes", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("private-test-key"),
            }),
          }),
        ),
      );
      const failure = yield* Effect.flip(
        makeApiClient(http).execute(TEST_OPERATION, {}),
      );
      expect(failure).toBeInstanceOf(NetworkFailure);
      expect(JSON.stringify(failure)).not.toContain("private-test-key");
    }),
  );

  it.effect.each(["header", "query"] as const)(
    "keeps %s credentials out of tracing failures",
    (location) =>
      Effect.gen(function* () {
        const secret = "private-tracing-key";
        const operation = compileOpenApi(
          {
            openapi: "3.1.2",
            servers: [{ url: "https://inventory.example.com" }],
            components: {
              securitySchemes: {
                Key: { type: "apiKey", in: location, name: "api-key" },
              },
            },
            security: [{ Key: [] }],
            paths: { "/items": { get: { responses: { "200": {} } } } },
          },
          { credentials: { Key: Redacted.make(secret) } },
        ).operations[0];
        if (operation === undefined) throw new Error("Missing test operation");
        const spans: Tracer.NativeSpan[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const http = HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error(`Transport failure containing ${secret}`),
              }),
            }),
          ),
        );
        const failure = yield* makeApiClient(http)
          .execute(operation, {})
          .pipe(Effect.flip, Effect.provideService(Tracer.Tracer, tracer));
        expect(failure).toBeInstanceOf(NetworkFailure);
        expect(spans.map((span) => span.name)).toContain("openapi.request");
        const recorded = spans.map((span) => ({
          attributes: Object.fromEntries(span.attributes),
          errors:
            span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
              ? Cause.prettyErrors(span.status.exit.cause, {
                  includeCauseInStack: true,
                }).map((error) => error.stack)
              : [],
        }));
        expect(JSON.stringify(recorded)).toContain("NetworkFailure");
        expect(JSON.stringify(recorded)).not.toContain(secret);
      }),
  );

  it.effect.each(["é", "😀"])(
    "limits received response bytes including Unicode (%s)",
    (text) =>
      Effect.gen(function* () {
        let cancelled = false;
        const encoded = new TextEncoder().encode(JSON.stringify(text));
        const http = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(encoded);
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
                {
                  headers: {
                    "Content-Type": "application/json",
                    "Content-Length": "1",
                  },
                },
              ),
            ),
          ),
        );
        const failure = yield* Effect.flip(
          makeApiClient(http, 10000, encoded.length - 1).execute(
            TEST_OPERATION,
            {},
          ),
        );
        expect(failure).toBeInstanceOf(InvalidResponse);
        expect(cancelled).toBe(true);
      }),
  );
  it.effect("accepts a response at the exact byte limit", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('"é"', {
              headers: { "Content-Type": "application/json" },
            }),
          ),
        ),
      );
      expect(
        yield* makeApiClient(http, 10000, 4).execute(TEST_OPERATION, {}),
      ).toBe("é");
    }),
  );
  it.effect("rejects invalid UTF-8 JSON responses", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new Uint8Array([0x22, 0xff, 0x22]), {
              headers: { "Content-Type": "application/json" },
            }),
          ),
        ),
      );
      expect(
        yield* Effect.flip(makeApiClient(http).execute(TEST_OPERATION, {})),
      ).toBeInstanceOf(InvalidResponse);
    }),
  );
  it.effect(
    "times out on the virtual clock and finalizes the upstream request",
    () =>
      Effect.gen(function* () {
        let signal: AbortSignal | undefined;
        let interrupted = false;
        const started = Deferred.makeUnsafe<void>();
        const http = HttpClient.make((_request, _url, abortSignal) => {
          signal = abortSignal;
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          );
        });
        const api = makeApiClient(http);
        const failure = yield* Effect.gen(function* () {
          const request = yield* api
            .execute(TEST_OPERATION, {})
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(started);
          yield* TestClock.adjust("10 seconds");
          return yield* Fiber.join(request);
        });
        expect(failure).toHaveProperty("_tag", "TimedOut");
        expect(interrupted).toBe(true);
        expect(signal?.aborted).toBe(true);
      }),
  );
});
