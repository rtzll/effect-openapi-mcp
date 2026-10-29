import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HttpApi } from "effect-openapi-mcp";
import { ApiLayer, lookupItem } from "../examples/library-program.ts";
import {
  lookupItemWithFallback,
  RateLimitedHttpClient,
} from "../examples/recovery-program.ts";

describe("library example composition", () => {
  it.effect("runs the same lookup with a substituted HttpApi and no HTTP", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const TestApi = Layer.succeed(HttpApi, {
        execute: (operation, input) => {
          calls.push({ name: operation.name, input });
          return Effect.succeed({ id: "test-item", label: "Test notebook" });
        },
      });
      expect(
        yield* lookupItem("test-item").pipe(Effect.provide(TestApi)),
      ).toEqual({
        id: "test-item",
        label: "Test notebook",
      });
      expect(calls).toEqual([
        { name: "get_item", input: { path: { id: "test-item" } } },
      ]);
    }),
  );

  it.effect(
    "recovers from an actual HTTP 429 with explicit fallback data",
    () =>
      Effect.gen(function* () {
        const layer = ApiLayer.pipe(Layer.provide(RateLimitedHttpClient));
        const failure = yield* lookupItem("item-1").pipe(
          Effect.provide(layer),
          Effect.flip,
        );
        expect(failure).toHaveProperty("_tag", "RateLimited");
        expect(
          yield* lookupItemWithFallback("item-1").pipe(Effect.provide(layer)),
        ).toEqual({
          id: "item-1",
          label: "Cached notebook",
          source: "fallback",
          retryAfter: "5",
        });
      }),
  );

  it.effect(
    "preserves HTTP 503 rather than applying the rate-limit fallback",
    () =>
      Effect.gen(function* () {
        const UnavailableHttpClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, { status: 503 }),
              ),
            ),
          ),
        );
        const failure = yield* lookupItemWithFallback("item-1").pipe(
          Effect.provide(ApiLayer.pipe(Layer.provide(UnavailableHttpClient))),
          Effect.flip,
        );
        expect(failure).toHaveProperty("_tag", "ApiRejected");
        expect(failure).toHaveProperty("status", 503);
      }),
  );
});
