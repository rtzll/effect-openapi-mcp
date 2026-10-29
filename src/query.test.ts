import { Effect, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "@effect/vitest";
import { makeApiClient } from "./api-client.ts";
import { InvalidArguments } from "./api-errors.ts";
import { compileOpenApi } from "./openapi.ts";
import { API_RESPONSES, accepts, findOperation } from "./test-fixtures.ts";

const flat = {
  type: "object",
  additionalProperties: false,
  properties: { city: { type: "string" }, active: { type: "boolean" } },
};
const compile = (
  parameter: unknown,
  version = "3.1.2",
  others: readonly unknown[] = [],
) =>
  compileOpenApi(
    {
      openapi: version,
      servers: [{ url: "https://query.example.com/v1" }],
      components: {
        schemas: { Item: { anyOf: [{ type: "string" }, { type: "integer" }] } },
        securitySchemes: {
          Key: { type: "apiKey", in: "query", name: "api_key" },
        },
      },
      security: [{ Key: [] }],
      paths: {
        "/health": { get: { responses: API_RESPONSES } },
        "/query": {
          get: {
            operationId: "search",
            parameters: [parameter, ...others],
            responses: API_RESPONSES,
          },
        },
      },
    },
    {
      parameterProfile: "spec",
      credentials: { Key: Redacted.make("secret &+é") },
    },
  );
const parameter = (style: string, explode: boolean, schema: unknown) => ({
  name: "filter",
  in: "query",
  style,
  explode,
  schema,
});
const withRequest = (expected: string) =>
  HttpClient.make((request) => {
    expect(request.url).toBe(
      `https://query.example.com/v1/query?${expected}&api_key=secret%20%26%2B%C3%A9`,
    );
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
      ),
    );
  });

describe("Strict OpenAPI query styles", () => {
  it.effect.each([
    ["form", false, "filter=city,A%20B%2BC%2C%7C%26%3D%C3%A9,active,false"],
    ["form", true, "city=A%20B%2BC%2C%7C%26%3D%C3%A9&active=false"],
    [
      "deepObject",
      true,
      "filter%5Bcity%5D=A%20B%2BC%2C%7C%26%3D%C3%A9&filter%5Bactive%5D=false",
    ],
  ] as const)(
    "executes a flat-object %s query (explode=%s)",
    ([style, explode, expected]) =>
      Effect.gen(function* () {
        const operation = findOperation(
          compile(parameter(style, explode, flat)),
          "search",
        );
        expect(
          accepts(operation, {
            query: { filter: { city: "a", active: false } },
          }),
        ).toBe(true);
        expect(accepts(operation, { query: { filter: { city: [] } } })).toBe(
          false,
        );
        yield* makeApiClient(withRequest(expected)).execute(operation, {
          query: { filter: { city: "A B+C,|&=é", active: false } },
        });
      }),
  );

  it.effect.each([
    ["form", false, "filter=a%2Bb,c%2Cd"],
    ["form", true, "filter=a%2Bb&filter=c%2Cd"],
    ["spaceDelimited", false, "filter=a%2Bb%20c%2Cd"],
    ["pipeDelimited", false, "filter=a%2Bb%7Cc%2Cd"],
  ] as const)(
    "encodes %s arrays independently from literal separators",
    ([style, explode, expected]) =>
      Effect.gen(function* () {
        const operation = findOperation(
          compile(
            parameter(style, explode, {
              type: "array",
              items: { type: "string" },
            }),
          ),
          "search",
        );
        yield* makeApiClient(withRequest(expected)).execute(operation, {
          query: { filter: ["a+b", "c,d"] },
        });
      }),
  );

  it.effect("resolves scalar array item references and unions", () =>
    Effect.gen(function* () {
      const operation = findOperation(
        compile(
          parameter("form", true, {
            type: "array",
            items: { $ref: "#/components/schemas/Item" },
          }),
        ),
        "search",
      );
      expect(accepts(operation, { query: { filter: ["a", 0] } })).toBe(true);
      expect(accepts(operation, { query: { filter: [null] } })).toBe(false);
      yield* makeApiClient(withRequest("filter=a&filter=0")).execute(
        operation,
        { query: { filter: ["a", 0] } },
      );
    }),
  );

  it.effect("rejects wire-name collisions before making a request", () =>
    Effect.gen(function* () {
      const operation = findOperation(
        compile(parameter("form", true, flat), "3.1.2", [
          { name: "city", in: "query", schema: { type: "string" } },
        ]),
        "search",
      );
      let sent = false;
      const http = HttpClient.make((request) => {
        sent = true;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("{}")),
        );
      });
      const failure = yield* Effect.flip(
        makeApiClient(http).execute(operation, {
          query: { filter: { city: "one" }, city: "two" },
        }),
      );
      expect(failure).toBeInstanceOf(InvalidArguments);
      expect(sent).toBe(false);
    }),
  );

  it.effect.each([
    {
      type: "object",
      additionalProperties: false,
      properties: {
        api_key: { type: "string" },
        city: { type: "string" },
      },
    },
    { type: "object", additionalProperties: { type: "string" } },
  ])(
    "rejects exploded object names that collide with query authentication",
    (schema) =>
      Effect.gen(function* () {
        const operation = findOperation(
          compile(parameter("form", true, schema)),
          "search",
        );
        const input = {
          query: { filter: { api_key: "replacement", city: "one" } },
        };
        expect(accepts(operation, input)).toBe(true);
        const http = HttpClient.make(() =>
          Effect.die("No request should be sent"),
        );
        const failure = yield* Effect.flip(
          makeApiClient(http).execute(operation, input),
        );
        expect(failure).toBeInstanceOf(InvalidArguments);
        expect(failure.message).toContain("conflict with authentication");
        expect(JSON.stringify(failure)).not.toContain("secret &+é");
      }),
  );

  it.effect.each(["spaceDelimited", "pipeDelimited"] as const)(
    "rejects ambiguous %s values before dispatch",
    (style) =>
      Effect.gen(function* () {
        const operation = findOperation(
          compile(
            parameter(style, false, {
              type: "array",
              items: { type: "string" },
            }),
          ),
          "search",
        );
        const http = HttpClient.make(() =>
          Effect.die("No request should be sent"),
        );
        const failure = yield* Effect.flip(
          makeApiClient(http).execute(operation, {
            query: { filter: [style === "spaceDelimited" ? "a b" : "a|b"] },
          }),
        );
        expect(failure).toBeInstanceOf(InvalidArguments);
        expect(failure.message).toContain("separator character");
      }),
  );
  it.effect("rejects ambiguous deepObject keys before dispatch", () =>
    Effect.gen(function* () {
      const operation = findOperation(
        compile(
          parameter("deepObject", true, {
            type: "object",
            additionalProperties: false,
            properties: { "nested[key]": { type: "string" } },
          }),
        ),
        "search",
      );
      const http = HttpClient.make(() =>
        Effect.die("No request should be sent"),
      );
      expect(
        yield* Effect.flip(
          makeApiClient(http).execute(operation, {
            query: { filter: { "nested[key]": "value" } },
          }),
        ),
      ).toBeInstanceOf(InvalidArguments);
    }),
  );
  it.each([
    ["3.0.4", false, true],
    ["3.1.2", false, true],
    ["3.2.1", false, false],
    ["3.0.4", true, false],
    ["3.1.2", true, false],
    ["3.2.1", true, false],
  ] as const)(
    "respects deepObject explode semantics in %s (%s)",
    (version, explode, unsupported) => {
      expect(
        compile(parameter("deepObject", explode, flat), version).unsupported
          .length > 0,
      ).toBe(unsupported);
    },
  );

  it.each([
    parameter("deepObject", true, { type: "array", items: { type: "string" } }),
    parameter("deepObject", true, {
      type: "object",
      additionalProperties: false,
      properties: { nested: flat },
    }),
    parameter("deepObject", true, { type: "object" }),
    parameter("spaceDelimited", true, {
      type: "array",
      items: { type: "string" },
    }),
    parameter("pipeDelimited", false, flat),
    parameter("matrix", false, { type: "string" }),
  ])("diagnoses an undefined or unsupported encoding", (value) => {
    expect(compile(value).unsupported).toHaveLength(1);
  });
});
