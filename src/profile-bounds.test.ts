import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient } from "effect/http";
import { InvalidArguments } from "./api-errors.ts";
import { makeApiClient } from "./api-client.ts";
import { compileOpenApi } from "./openapi.ts";
import { MAX_BRACKET_BYTES, MAX_BRACKET_PAIRS } from "./parameter-encoding.ts";

const operation = (schema: unknown) =>
  compileOpenApi(
    {
      openapi: "3.2.1",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/search": {
          get: {
            parameters: ["first", "second"].map((name) => ({
              name,
              in: "query",
              style: "deepObject",
              schema,
            })),
          },
        },
      },
    },
    { parameterProfile: "brackets-indexed" },
  ).operations[0];

it.effect("bounds profile pairs across separate query parameters", () =>
  Effect.gen(function* () {
    const selected = operation({ type: "array", items: { type: "integer" } });
    if (selected === undefined) return yield* Effect.die("Missing operation");
    const api = makeApiClient(
      HttpClient.make(() => Effect.die("Oversized query must not dispatch")),
    );
    const values = Array.from(
      { length: Math.floor(MAX_BRACKET_PAIRS / 2) + 1 },
      (_, index) => index,
    );
    const failure = yield* Effect.flip(
      api.execute(selected, { query: { first: values, second: values } }),
    );
    expect(failure).toBeInstanceOf(InvalidArguments);
    expect(failure.message).toContain("pair or encoded byte limit");
  }),
);

it.effect("bounds profile bytes across separate query parameters", () =>
  Effect.gen(function* () {
    const selected = operation({ type: "string" });
    if (selected === undefined) return yield* Effect.die("Missing operation");
    const api = makeApiClient(
      HttpClient.make(() => Effect.die("Oversized query must not dispatch")),
    );
    const value = "x".repeat(MAX_BRACKET_BYTES / 2);
    const failure = yield* Effect.flip(
      api.execute(selected, { query: { first: value, second: value } }),
    );
    expect(failure).toBeInstanceOf(InvalidArguments);
    expect(failure.message).toContain("pair or encoded byte limit");
  }),
);
