import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeApiClient } from "./api-client.ts";
import { InvalidArguments } from "./api-errors.ts";
import { encodeFormBody } from "./form.ts";
import { inspectCatalog } from "./inspection.ts";
import { compileOpenApi, type CompileOptions } from "./openapi.ts";
import { MAX_BRACKET_BYTES, MAX_BRACKET_PAIRS } from "./parameter-encoding.ts";
import { API_RESPONSES, accepts, findOperation } from "./test-fixtures.ts";

const versions = ["3.0.4", "3.1.2", "3.2.1"] as const;
const nested = {
  type: "object",
  additionalProperties: false,
  required: ["owner", "tags"],
  properties: {
    owner: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "integer", minimum: 1 } },
    },
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string", minLength: 1 },
    },
  },
};
const compileQuery = (
  schema: unknown,
  options: CompileOptions = {},
  version = "3.1.2",
  parameter: object = {},
  schemas: object = { Filter: nested },
) =>
  compileOpenApi(
    {
      openapi: version,
      servers: [{ url: "https://api.example.com" }],
      components: { schemas },
      paths: {
        "/health": { get: { responses: API_RESPONSES } },
        "/search": {
          get: {
            operationId: "search",
            parameters: [
              {
                name: "filter",
                in: "query",
                style: "deepObject",
                explode: false,
                schema,
                ...parameter,
              },
            ],
            responses: API_RESPONSES,
          },
        },
      },
    },
    options,
  );
const compileForm = (
  schema: unknown,
  encoding: unknown,
  options: CompileOptions = {},
  version = "3.1.2",
) =>
  compileOpenApi(
    {
      openapi: version,
      servers: [{ url: "https://api.example.com" }],
      components: { schemas: { Filter: nested } },
      paths: {
        "/health": { get: { responses: API_RESPONSES } },
        "/submit": {
          post: {
            operationId: "submit",
            requestBody: {
              required: true,
              content: {
                "application/x-www-form-urlencoded": { schema, encoding },
              },
            },
            responses: API_RESPONSES,
          },
        },
      },
    },
    options,
  );
const profiled = { parameterProfile: "brackets-indexed" } as const;
const bodySchema = (properties: object) => ({
  type: "object",
  additionalProperties: false,
  properties,
});
const formDescriptor = (catalog: ReturnType<typeof compileForm>) => {
  const descriptor = findOperation(catalog, "submit").body;
  if (descriptor?.mode !== "form") throw new Error("Expected form descriptor");
  return descriptor.form;
};
const noRequest = HttpClient.make(() =>
  Effect.die("Invalid wire values must not dispatch."),
);

describe("Indexed bracket compilation", () => {
  it.each(versions)(
    "uses the profile only for explicit deepObject query declarations (%s)",
    (version) => {
      const catalog = compileQuery(
        { $ref: "#/components/schemas/Filter" },
        profiled,
        version,
      );
      const operation = findOperation(catalog, "search");
      expect(operation.parameters[0]).toEqual({
        name: "filter",
        location: "query",
        encoding: {
          style: "deepObject",
          explode: false,
          profile: "brackets-indexed",
        },
      });
      expect(
        accepts(operation, {
          query: { filter: { owner: { id: 2 }, tags: ["a", "b"] } },
        }),
      ).toBe(true);
      expect(
        accepts(operation, {
          query: { filter: { owner: { id: 0 }, tags: ["a"] } },
        }),
      ).toBe(false);
      expect(
        accepts(operation, {
          query: { filter: { owner: { id: 2 }, tags: [] } },
        }),
      ).toBe(false);
      expect(
        accepts(operation, {
          query: { filter: { owner: { id: 2 }, tags: [""] } },
        }),
      ).toBe(false);
      expect(
        accepts(operation, {
          query: { filter: { owner: { id: 2 }, tags: ["a"], extra: true } },
        }),
      ).toBe(false);
      expect(compileQuery(nested, {}, version).unsupported).toEqual([]);
      expect(
        compileQuery(nested, { parameterProfile: "spec" }, version).unsupported,
      ).toHaveLength(1);
    },
  );
  it.each(versions)(
    "uses native schemas for deepObject scalar/array/union roots (%s)",
    (version) => {
      for (const [schema, valid, invalid] of [
        [{ type: "integer", minimum: 1 }, 2, 0],
        [
          {
            type: "array",
            items: { type: "integer", minimum: 1 },
            minItems: 1,
          },
          [2, 3],
          [0],
        ],
        [
          {
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "integer", minimum: 1 },
            ],
          },
          "active",
          false,
        ],
      ] as const) {
        const operation = findOperation(
          compileQuery(schema, profiled, version),
          "search",
        );
        expect(accepts(operation, { query: { filter: valid } })).toBe(true);
        expect(accepts(operation, { query: { filter: invalid } })).toBe(false);
      }
    },
  );
  it.each(versions)(
    "diagnoses required root null using native parameter validation (%s)",
    (version) => {
      const nullable = version.startsWith("3.0.")
        ? {
            type: "object",
            nullable: true,
            properties: { id: { type: "integer" } },
          }
        : { type: ["object", "null"], properties: { id: { type: "integer" } } };
      const catalog = compileQuery(nullable, profiled, version, {
        required: true,
      });
      expect(catalog.operations.map((operation) => operation.name)).toEqual([
        "get_health",
      ]);
      expect(catalog.unsupported[0]?.reason).toBe(
        "Required nullable query parameters cannot be omitted.",
      );
      const referenced = compileQuery(
        { $ref: "#/components/schemas/Nullable" },
        profiled,
        version,
        { required: true },
        { Nullable: nullable },
      );
      expect(referenced.unsupported[0]?.reason).toBe(
        "Required nullable query parameters cannot be omitted.",
      );
      const nonnullable = compileQuery(nested, profiled, version, {
        required: true,
      });
      expect(nonnullable.unsupported).toEqual([]);
      expect(accepts(findOperation(nonnullable, "search"), {})).toBe(false);
    },
  );
  it("retains other query styles and their conservative wire-shape rules", () => {
    const catalog = compileQuery(nested, profiled, "3.1.2", { style: "form" });
    expect(catalog.unsupported).toHaveLength(1);
    const operation = findOperation(
      compileQuery(
        { type: "array", items: { type: "string" } },
        profiled,
        "3.1.2",
        { style: "form", explode: true },
      ),
      "search",
    );
    expect(operation.parameters[0]).toEqual({
      name: "filter",
      location: "query",
      encoding: { style: "form", explode: true },
    });
  });
  it("keeps empty query names invalid at the native OpenAPI boundary", () => {
    expect(() => compileQuery(nested, profiled, "3.1.2", { name: "" })).toThrow(
      "Invalid OpenAPI document",
    );
  });
  it("uses native union validation for the required-null probe", () => {
    expect(
      compileQuery(
        { anyOf: [{ type: "integer" }, { type: "null" }] },
        profiled,
        "3.1.2",
        { required: true },
      ).unsupported[0]?.reason,
    ).toBe("Required nullable query parameters cannot be omitted.");
  });
  it.each([
    "0",
    "01",
    "filter[owner]",
    "__proto__",
    "constructor",
    "prototype",
  ])("diagnoses unsafe query profile roots (%s)", (name) => {
    const catalog = compileQuery(nested, profiled, "3.1.2", { name });
    expect(catalog.unsupported[0]?.reason).toContain("safe nonnumeric");
  });
  it.effect("keeps optional root-null query omission", () =>
    Effect.gen(function* () {
      const operation = findOperation(
        compileQuery(
          { type: ["object", "null"], properties: { id: { type: "integer" } } },
          profiled,
        ),
        "search",
      );
      expect(accepts(operation, { query: { filter: null } })).toBe(true);
      const http = HttpClient.make((request) => {
        expect(request.url).toBe("https://api.example.com/search");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("{}", {
              headers: { "Content-Type": "application/json" },
            }),
          ),
        );
      });
      yield* makeApiClient(http).execute(operation, {
        query: { filter: null },
      });
    }),
  );
  it.effect(
    "reports the selected serialization profile without target URLs or credentials",
    () =>
      Effect.gen(function* () {
        const report = yield* inspectCatalog(
          compileQuery(nested, {
            ...profiled,
            baseUrl: new URL("https://private-target.example.com"),
          }),
        );
        expect(
          report.tools.find((tool) => tool.name === "search")?.serialization
            .parameters[0],
        ).toHaveProperty("encoding.profile", "brackets-indexed");
        expect(JSON.stringify(report)).not.toContain(
          "private-target.example.com",
        );
      }),
  );
  it.each(versions)(
    "compiles and validates explicitly styled nested form fields (%s)",
    (version) => {
      const root = bodySchema({
        filter: { $ref: "#/components/schemas/Filter" },
      });
      const catalog = compileForm(
        root,
        { filter: { style: "deepObject", explode: false } },
        profiled,
        version,
      );
      const operation = findOperation(catalog, "submit");
      expect(
        accepts(operation, {
          body: { filter: { owner: { id: 2 }, tags: ["one two", "x+y"] } },
        }),
      ).toBe(true);
      expect(
        accepts(operation, {
          body: { filter: { owner: { id: 0 }, tags: ["one"] } },
        }),
      ).toBe(false);
      expect(
        encodeFormBody(
          { filter: { owner: { id: 2 }, tags: ["one two", "x+y"] } },
          formDescriptor(catalog),
        ),
      ).toBe(
        "filter%5Bowner%5D%5Bid%5D=2&filter%5Btags%5D%5B0%5D=one+two&filter%5Btags%5D%5B1%5D=x%2By",
      );
      expect(
        compileForm(
          root,
          { filter: { style: "deepObject", explode: false } },
          { parameterProfile: "spec" },
          version,
        ).unsupported,
      ).toHaveLength(1);
    },
  );
  it("preserves default complex JSON form encoding under the profile", () => {
    const catalog = compileForm(bodySchema({ filter: nested }), {}, profiled);
    expect(formDescriptor(catalog).fields.filter).toEqual({ mode: "auto" });
    expect(
      encodeFormBody(
        { filter: { owner: { id: 2 }, tags: ["a"] } },
        formDescriptor(catalog),
      ),
    ).toBe(
      "filter=%7B%22owner%22%3A%7B%22id%22%3A2%7D%2C%22tags%22%3A%5B%22a%22%5D%7D",
    );
  });
  it.each(["0", "filter[owner]", "__proto__", "constructor"])(
    "diagnoses unsafe form profile roots (%s)",
    (name) => {
      const catalog = compileForm(
        bodySchema(Object.fromEntries([[name, nested]])),
        Object.fromEntries([[name, { style: "deepObject" }]]),
        profiled,
      );
      expect(catalog.unsupported[0]?.reason).toContain("safe nonnumeric");
    },
  );
  it.effect.each([
    { filter: { owner: { id: 2 } }, "filter[other]": "literal" },
    { "filter[other]": "literal", filter: { owner: { id: 2 } } },
  ])(
    "rejects disjoint form fields sharing a profile namespace before dispatch (%s)",
    (body) =>
      Effect.gen(function* () {
        const catalog = compileForm(
          bodySchema({
            filter: {
              type: "object",
              properties: {
                owner: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                },
              },
            },
            "filter[other]": { type: "string" },
          }),
          { filter: { style: "deepObject" } },
          profiled,
        );
        const operation = findOperation(catalog, "submit");
        expect(accepts(operation, { body })).toBe(true);
        expect(
          yield* Effect.flip(
            makeApiClient(noRequest).execute(operation, { body }),
          ),
        ).toBeInstanceOf(InvalidArguments);
      }),
  );
  it("keeps percent-escaped literal form names distinct after one wire decode", () => {
    const catalog = compileForm(
      bodySchema({
        filter: { type: "object", properties: { id: { type: "integer" } } },
        "filter%5Bid%5D": { type: "string" },
      }),
      { filter: { style: "deepObject" } },
      profiled,
    );
    const encoded = encodeFormBody(
      { filter: { id: 2 }, "filter%5Bid%5D": "literal" },
      formDescriptor(catalog),
    );
    expect(encoded).toBe("filter%5Bid%5D=2&filter%255Bid%255D=literal");
  });
  it.effect.each([null, { nested: null }] as const)(
    "rejects unrepresentable form profile values before dispatch (%s)",
    (value) =>
      Effect.gen(function* () {
        const catalog = compileForm(
          bodySchema({ filter: true }),
          { filter: { style: "deepObject" } },
          profiled,
        );
        const operation = findOperation(catalog, "submit");
        const body = yield* Schema.decodeEffect(Schema.MutableJson)({
          filter: value,
        });
        expect(
          Result.isSuccess(
            Schema.decodeResult(operation.parametersSchema)({ body }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.flip(
            makeApiClient(noRequest).execute(operation, { body }),
          ),
        ).toBeInstanceOf(InvalidArguments);
      }),
  );
  it.effect(
    "bounds pairs across profile and ordinary form fields before dispatch",
    () =>
      Effect.gen(function* () {
        const array = { type: "array", items: { type: "integer" } };
        const operation = findOperation(
          compileForm(
            bodySchema({ first: array, second: array }),
            { first: { style: "deepObject" } },
            profiled,
          ),
          "submit",
        );
        const values = Array.from(
          { length: Math.floor(MAX_BRACKET_PAIRS / 2) + 1 },
          (_, index) => index,
        );
        const body = { first: values, second: values };
        expect(accepts(operation, { body })).toBe(true);
        const failure = yield* Effect.flip(
          makeApiClient(noRequest).execute(operation, { body }),
        );
        expect(failure).toBeInstanceOf(InvalidArguments);
        expect(failure.message).toContain("wire pair limit");
      }),
  );
  it.effect(
    "bounds encoded bytes across profile and ordinary form fields before dispatch",
    () =>
      Effect.gen(function* () {
        const operation = findOperation(
          compileForm(
            bodySchema({
              first: { type: "string" },
              second: { type: "string" },
            }),
            { first: { style: "deepObject" } },
            profiled,
          ),
          "submit",
        );
        const value = "x".repeat(Math.floor(MAX_BRACKET_BYTES / 2));
        const body = { first: value, second: value };
        expect(accepts(operation, { body })).toBe(true);
        const failure = yield* Effect.flip(
          makeApiClient(noRequest).execute(operation, { body }),
        );
        expect(failure).toBeInstanceOf(InvalidArguments);
        expect(failure.message).toContain("encoded byte limit");
      }),
  );
  it.effect(
    "keeps the form pair limit active when an optional profile field is omitted",
    () =>
      Effect.gen(function* () {
        const array = { type: "array", items: { type: "integer" } };
        const operation = findOperation(
          compileForm(
            bodySchema({ optional: array, ordinary: array }),
            { optional: { style: "deepObject" } },
            profiled,
          ),
          "submit",
        );
        const body = {
          ordinary: Array.from(
            { length: MAX_BRACKET_PAIRS + 1 },
            (_, index) => index,
          ),
        };
        expect(accepts(operation, { body })).toBe(true);
        const failure = yield* Effect.flip(
          makeApiClient(noRequest).execute(operation, { body }),
        );
        expect(failure).toBeInstanceOf(InvalidArguments);
        expect(failure.message).toContain("wire pair limit");
      }),
  );
  it.effect(
    "keeps the form byte limit active when an optional profile field is omitted",
    () =>
      Effect.gen(function* () {
        const operation = findOperation(
          compileForm(
            bodySchema({
              optional: { type: "string" },
              ordinary: { type: "string" },
            }),
            { optional: { style: "deepObject" } },
            profiled,
          ),
          "submit",
        );
        const body = { ordinary: "x".repeat(MAX_BRACKET_BYTES) };
        expect(accepts(operation, { body })).toBe(true);
        const failure = yield* Effect.flip(
          makeApiClient(noRequest).execute(operation, { body }),
        );
        expect(failure).toBeInstanceOf(InvalidArguments);
        expect(failure.message).toContain("encoded byte limit");
      }),
  );
});
