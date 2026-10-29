import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { lookupItem } from "./library-program.ts";

// This is a real HTTP status flowing through makeApiClient's typed error channel.
export const RateLimitedHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: 429, headers: { "Retry-After": "5" } }),
      ),
    ),
  ),
);

// Recovery is an explicit application policy. Other failures still propagate.
export const lookupItemWithFallback = Effect.fn(
  "example.lookupItemWithFallback",
)((id: string) =>
  lookupItem(id).pipe(
    Effect.catchTag("RateLimited", (error) =>
      Effect.succeed({
        id,
        label: "Cached notebook",
        source: "fallback",
        retryAfter: Option.getOrNull(error.retryAfter),
      }),
    ),
  ),
);
