import { Effect, Result, Schema, SchemaRepresentation } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import { compileOpenApi } from "./openapi.ts";
import { ARGUMENTS_SCHEMA } from "./schema.ts";
import { accepts, API_RESPONSES, findOperation } from "./test-fixtures.ts";

const operationFor = (
  schema: object | boolean,
  components: object = {},
  openapi = "3.1.0",
) =>
  findOperation(
    compileOpenApi({
      openapi,
      servers: [{ url: "https://api.example.com/" }],
      components: { schemas: components },
      paths: {
        "/values": {
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema } },
            },
            responses: API_RESPONSES,
          },
        },
      },
    }),
    "post_values",
  );

describe("Library argument boundaries", () => {
  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite path and header numbers (%s)",
    (value) => {
      const cases: Array<typeof ARGUMENTS_SCHEMA.Encoded> = [
        { path: { id: value } },
        { headers: { "X-Value": value } },
        { headers: { "X-Values": [1, value] } },
      ];
      for (const arguments_ of cases) {
        expect(
          Result.isFailure(Schema.decodeResult(ARGUMENTS_SCHEMA)(arguments_)),
        ).toBe(true);
      }
    },
  );
  it("retains finite numbers, strings and booleans in scalar and array parameters", () => {
    const arguments_ = {
      path: { id: -2.5, label: "item", enabled: true },
      headers: { "X-Count": 0, "X-Values": [1.5, "tag", false] },
    };
    expect(Schema.decodeSync(ARGUMENTS_SCHEMA)(arguments_)).toEqual(arguments_);
  });
});

describe("Native schema import semantics", () => {
  it.each([
    "https://json-schema.org/draft/2020-12/schema",
    "https://spec.openapis.org/oas/3.1/dialect/base",
  ])("honors a supported document-level dialect (%s)", (jsonSchemaDialect) => {
    const catalog = compileOpenApi({
      openapi: "3.1.0",
      jsonSchemaDialect,
      servers: [{ url: "https://api.example.com/" }],
      paths: { "/items": { get: { responses: API_RESPONSES } } },
    });
    expect(catalog.operations).toHaveLength(1);
  });
  it("rejects an unsupported document-level dialect", () => {
    expect(() =>
      compileOpenApi({
        openapi: "3.1.0",
        jsonSchemaDialect: "https://example.com/custom-dialect",
        servers: [{ url: "https://api.example.com/" }],
        paths: { "/items": { get: { responses: API_RESPONSES } } },
      }),
    ).toThrow("Unsupported JSON Schema dialect");
  });
  it("rejects explicit custom vocabularies", () => {
    expect(() =>
      operationFor({
        $vocabulary: { "https://example.com/vocabulary": true },
        type: "string",
      }),
    ).toThrow("Explicit JSON Schema vocabularies are not supported");
  });
  it("preserves numeric constraints across nullable type unions", () => {
    const operation = operationFor({
      type: ["integer", "null"],
      minimum: 2,
      maximum: 5,
    });
    for (const body of [null, 2, 5]) {
      expect(accepts(operation, { body })).toBe(true);
    }
    for (const body of [1, 6, 2.5, "2", false]) {
      expect(accepts(operation, { body })).toBe(false);
    }
  });
  it("preserves reference intersections rather than adding a nullable branch", () => {
    const operation = operationFor(
      { type: ["string", "null"], $ref: "#/components/schemas/Choice" },
      { Choice: { type: "string", enum: ["A", "B"] } },
    );
    expect(accepts(operation, { body: "A" })).toBe(true);
    expect(accepts(operation, { body: null })).toBe(false);
    expect(accepts(operation, { body: "C" })).toBe(false);
  });
  it("keeps oneOf exclusive when branches overlap", () => {
    const operation = operationFor({
      oneOf: [
        { type: "integer", minimum: 0 },
        { type: "number", maximum: 10 },
      ],
    });
    expect(accepts(operation, { body: 5 })).toBe(false);
    expect(accepts(operation, { body: 15 })).toBe(true);
    expect(accepts(operation, { body: -5 })).toBe(true);
  });
  it("exports integer oneOf branches without weakening decoder exclusivity", () => {
    const operation = operationFor({
      oneOf: [{ type: "integer" }, { type: "number" }],
    });
    const exported = Tool.getJsonSchema(
      Tool.dynamic(operation.name, { parameters: operation.parametersSchema }),
    );
    expect(exported).toMatchObject({
      properties: {
        body: {
          oneOf: [
            {
              type: "integer",
              minimum: Number.MIN_SAFE_INTEGER,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            { type: "number" },
          ],
        },
      },
    });
    expect(accepts(operation, { body: 1 })).toBe(false);
    expect(accepts(operation, { body: 1.5 })).toBe(true);
  });
  it("counts Unicode code points and enforces patterns", () => {
    const unicode = operationFor({
      type: "string",
      minLength: 3,
      maxLength: 3,
    });
    expect(accepts(unicode, { body: "😀😀😀" })).toBe(true);
    expect(accepts(unicode, { body: "😀😀" })).toBe(false);
    const patterned = operationFor({ type: "string", pattern: "^[A-Z]+$" });
    expect(accepts(patterned, { body: "ABC" })).toBe(true);
    expect(accepts(patterned, { body: "abc" })).toBe(false);
  });
  it("retains open-object data and rejects closed-object excess properties", () => {
    const open = operationFor({
      type: "object",
      properties: { label: { type: "string" } },
    });
    const closed = operationFor({
      type: "object",
      properties: { label: { type: "string" } },
      additionalProperties: false,
    });
    expect(
      accepts(open, { body: { label: "Item", metadata: { value: 1 } } }),
    ).toBe(true);
    expect(
      accepts(closed, { body: { label: "Item", metadata: { value: 1 } } }),
    ).toBe(false);
  });
  it("preserves boolean component schemas", () => {
    const allow = operationFor(
      { $ref: "#/components/schemas/Allow" },
      { Allow: true },
    );
    const deny = operationFor(
      { $ref: "#/components/schemas/Deny" },
      { Deny: false },
    );
    expect(accepts(allow, { body: { anything: true } })).toBe(true);
    expect(accepts(deny, { body: { anything: true } })).toBe(false);
  });
  it("rejects unsupported dialects instead of ignoring their rules", () => {
    expect(() =>
      operationFor({
        $schema: "https://example.com/custom-dialect",
        type: "string",
      }),
    ).toThrow("Unsupported JSON Schema dialect");
  });
  it.each(["3.0.4", "3.1.2", "3.2.1"])(
    "enforces structural JSON uniqueness using the native importer (%s)",
    (openapi) => {
      const operation = operationFor(
        { type: "array", items: {}, uniqueItems: true },
        {},
        openapi,
      );
      const unique: unknown[] = [
        [],
        [{ a: 1 }, { a: 2 }],
        [[1], [2]],
        [1, true],
        [0, false],
        [null, "null"],
        [{}, [], false, null, 1, "{}"],
        [{ a: [1, { b: false }] }, { a: [1, { b: 0 }] }],
      ];
      const duplicates: unknown[] = [
        [1, 1.0],
        [null, null],
        [false, false],
        [
          { a: 1, b: 2 },
          { b: 2, a: 1 },
        ],
        [
          [1, { a: 2 }],
          [1, { a: 2 }],
        ],
        [{ a: [1, { b: true }] }, { a: [1, { b: true }] }],
        [{}, [], false, null, {}, 1],
      ];
      for (const body of unique)
        expect(accepts(operation, { body })).toBe(true);
      for (const body of duplicates)
        expect(accepts(operation, { body })).toBe(false);
    },
  );
  it("preserves distinct object data while checking uniqueness alongside item schemas", () => {
    const operation = operationFor({
      type: "array",
      uniqueItems: true,
      items: {
        type: "object",
        required: ["id", "metadata"],
        properties: {
          id: { type: "integer", minimum: 1 },
          metadata: { type: "string", readOnly: true, default: "default" },
        },
      },
    });
    expect(
      accepts(operation, { body: [{ id: 1 }, { id: 1, extra: "kept" }] }),
    ).toBe(true);
    expect(
      accepts(operation, { body: [{ id: 1 }, { id: 1, metadata: "default" }] }),
    ).toBe(true);
    expect(
      accepts(operation, {
        body: [
          { id: 1, metadata: "a" },
          { id: 1, metadata: "b" },
        ],
      }),
    ).toBe(true);
    expect(
      accepts(operation, {
        body: [
          { id: 1, extra: "same" },
          { extra: "same", id: 1 },
        ],
      }),
    ).toBe(false);
    expect(accepts(operation, { body: [{ id: 0 }] })).toBe(false);
  });
  it("retains typed additional properties and item constraints when enforcing uniqueness", () => {
    const operation = operationFor({
      type: "array",
      uniqueItems: true,
      items: {
        type: "object",
        additionalProperties: { type: "integer", minimum: 1 },
      },
    });
    expect(accepts(operation, { body: [{ first: 1 }, { first: 2 }] })).toBe(
      true,
    );
    expect(
      accepts(operation, {
        body: [
          { first: 1, second: 2 },
          { second: 2, first: 1 },
        ],
      }),
    ).toBe(false);
    expect(accepts(operation, { body: [{ first: 0 }] })).toBe(false);
    expect(accepts(operation, { body: [{ first: "1" }] })).toBe(false);
  });
  it("preserves closed objects instead of stripping excess fields to produce artificial duplicates", () => {
    const operation = operationFor({
      type: "array",
      uniqueItems: true,
      items: {
        type: "object",
        properties: { id: { type: "integer" } },
        additionalProperties: false,
      },
    });
    expect(accepts(operation, { body: [{ id: 1 }, { id: 2 }] })).toBe(true);
    expect(
      accepts(operation, { body: [{ id: 1 }, { id: 1, extra: "forbidden" }] }),
    ).toBe(false);
  });
  it.effect(
    "exports uniqueness and retains it through a second native schema import",
    () =>
      Effect.gen(function* () {
        const operation = operationFor({
          type: "array",
          items: {},
          uniqueItems: true,
        });
        const exported = Schema.toJsonSchemaDocument(
          operation.parametersSchema,
        );
        expect(exported.schema).toMatchObject({
          properties: { body: { type: "array", uniqueItems: true } },
        });
        const imported = Schema.make<Schema.Codec<unknown>>(
          SchemaRepresentation.fromJsonSchemaDocument(exported).ast,
        );
        const good = { body: [{ id: 1 }, { id: 2 }] };
        expect(yield* Schema.decodeEffect(imported)(good)).toEqual(good);
        const result = yield* Effect.result(
          Schema.decodeEffect(imported)({
            body: [
              { id: 1, b: [true] },
              { b: [true], id: 1 },
            ],
          }),
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "SchemaError" },
        });
        const codecFailure = Schema.decodeResult(operation.parametersSchema)({
          body: [1, 1.0],
        });
        expect(Result.isFailure(codecFailure)).toBe(true);
      }),
  );
});
