import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { compileOpenApi } from "./openapi.ts";
import { makeApiClient } from "./api-client.ts";
import { InvalidArguments } from "./api-errors.ts";

const document = {
  openapi: "3.1.0",
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/customers": {
      post: { responses: { "200": { content: { "application/json": {} } } } },
    },
  },
};
it.effect(
  "advertises per-call headers and sends distinct keys with fixed defaults",
  () =>
    Effect.gen(function* () {
      const operation = compileOpenApi(document, {
        toolHeaders: ["Idempotency-Key"],
      }).operations[0];
      if (operation === undefined) throw new Error("Missing operation");
      const observed: string[] = [];
      const api = makeApiClient(
        HttpClient.make((request) => {
          expect(request.headers["stripe-version"]).toBe("2026-09-30.endive");
          expect(request.headers["stripe-account"]).toBe("acct_fixture");
          observed.push(request.headers["idempotency-key"] ?? "missing");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ id: "fixture" }),
            ),
          );
        }),
        10000,
        undefined,
        undefined,
        {
          "Stripe-Version": Redacted.make("2026-09-30.endive"),
          "Stripe-Account": Redacted.make("acct_fixture"),
        },
      );
      for (const key of ["operation-1", "operation-2"]) {
        const input = yield* Schema.decodeEffect(operation.parametersSchema)({
          headers: { "Idempotency-Key": key },
        });
        yield* api.execute(operation, input);
      }
      expect(observed).toEqual(["operation-1", "operation-2"]);
    }),
);
it.effect(
  "rejects reserved defaults and authentication collisions before dispatch",
  () =>
    Effect.gen(function* () {
      const operation = compileOpenApi(document).operations[0];
      if (operation === undefined) throw new Error("Missing operation");
      const http = HttpClient.make(() =>
        Effect.die("Invalid headers must not dispatch"),
      );
      for (const name of [
        "Host",
        "Content-Type",
        "Authorization",
        "Cookie",
        "X-Api-Key",
      ]) {
        const selected = {
          ...operation,
          authentication: [
            {
              scheme: "Key",
              location: "header" as const,
              name: "X-Api-Key",
              value: Redacted.make("credential"),
            },
          ],
        };
        const failure = yield* Effect.flip(
          makeApiClient(http, 10000, undefined, undefined, {
            [name]: Redacted.make("secret"),
          }).execute(selected, {}),
        );
        expect(failure).toBeInstanceOf(InvalidArguments);
        expect(failure.message).not.toContain("secret");
      }
    }),
);
it("does not expose reserved headers as optional tool arguments", () => {
  for (const name of ["Host", "Authorization", "Cookie", "Content-Type"])
    expect(() => compileOpenApi(document, { toolHeaders: [name] })).toThrow();
});
