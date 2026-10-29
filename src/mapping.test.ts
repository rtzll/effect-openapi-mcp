import { Redacted } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { compileOpenApi } from "./openapi.ts";
import { accepts, API_RESPONSES } from "./test-fixtures.ts";

const document = (
  operation: object,
  components: object = {},
  extra: object = {},
) => ({
  openapi: "3.1.0",
  servers: [{ url: "https://api.example.com/v1" }],
  components,
  paths: { "/value": { post: { responses: API_RESPONSES, ...operation } } },
  ...extra,
});
const operationFor = (
  schema: object | boolean,
  components: object = {},
  extra: object = {},
) => {
  const catalog = compileOpenApi(
    document(
      {
        requestBody: {
          required: true,
          content: { "application/json": { schema } },
        },
      },
      { schemas: components },
      extra,
    ),
  );
  const operation = catalog.operations[0];
  if (operation === undefined) {
    throw new Error("Missing test operation.");
  }
  return operation;
};

describe("Generic mapping boundaries", () => {
  it("diagnoses header credentials that the transport would silently change", () => {
    expect(() =>
      compileOpenApi(
        document(
          { security: [{ Key: [] }] },
          {
            securitySchemes: {
              Key: { type: "apiKey", in: "header", name: "X-Key" },
            },
          },
        ),
        { credentials: { Key: Redacted.make(" private-key ") } },
      ),
    ).toThrow("Credential cannot be transmitted unchanged");
  });
  it.each(["", "^https://", "\n"])(
    "canonicalizes regex spelling without weakening validation: %s",
    (pattern) => {
      const operation = operationFor({ type: "string", pattern });
      for (const body of ["https://example.com", "other", "line\nnext"]) {
        expect(accepts(operation, { body })).toBe(
          new RegExp(pattern, "u").test(body),
        );
      }
    },
  );
  it.each(["repos/get", "tools.with spaces", "工具", "a".repeat(200)])(
    "normalizes %s deterministically",
    (operationId) => {
      const spec = document({ operationId });
      const full = compileOpenApi(spec).operations[0]?.name;
      expect(full).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      expect(
        compileOpenApi(spec, { methods: ["post"] }).operations[0]?.name,
      ).toBe(full);
      expect(compileOpenApi(spec).operations[0]?.name).toBe(full);
    },
  );
  it("keeps normalized names distinct from valid names and each other", () => {
    const catalog = compileOpenApi(
      document(
        {},
        {},
        {
          paths: {
            "/a": {
              get: { operationId: "repos/get", responses: API_RESPONSES },
            },
            "/b": {
              get: { operationId: "repos get", responses: API_RESPONSES },
            },
            "/c": {
              get: { operationId: "repos_get", responses: API_RESPONSES },
            },
          },
        },
      ),
    );
    expect(
      new Set(catalog.operations.map((operation) => operation.name)).size,
    ).toBe(3);
  });
  it.each(["oauth2", "openIdConnect", "http"])(
    "injects an opaque token for %s including scheme references",
    (type) => {
      const catalog = compileOpenApi(
        document(
          { security: [{ Token: ["read"] }] },
          {
            securitySchemes: {
              Token: { $ref: "#/components/securitySchemes/Bearer" },
              Bearer: { type, scheme: "bearer" },
            },
          },
        ),
        { credentials: { Token: Redacted.make("private-access-token") } },
      );
      expect(catalog.operations[0]?.authentication[0]?.value).toEqual(
        Redacted.make("Bearer private-access-token"),
      );
      expect(JSON.stringify(catalog)).not.toContain("private-access-token");
    },
  );
  it("encodes HTTP Basic credentials as UTF-8", () => {
    const catalog = compileOpenApi(
      document(
        { security: [{ Basic: [] }] },
        { securitySchemes: { Basic: { type: "http", scheme: "basic" } } },
      ),
      { credentials: { Basic: Redacted.make("name:páss:word") } },
    );
    expect(catalog.operations[0]?.authentication[0]?.value).toEqual(
      Redacted.make(
        `Basic ${Buffer.from("name:páss:word").toString("base64")}`,
      ),
    );
  });
  it("does not request response-only required fields in input", () => {
    const operation = operationFor(
      {
        type: "object",
        required: ["id", "label"],
        properties: {
          id: { $ref: "#/components/schemas/Id" },
          label: { type: "string", writeOnly: true },
        },
      },
      { Id: { type: "string", readOnly: true } },
    );
    expect(accepts(operation, { body: { label: "A" } })).toBe(true);
    expect(accepts(operation, { body: {} })).toBe(false);
  });
  it("retains arbitrary JSON keys without prototype pollution", () => {
    const operation = operationFor({
      type: "object",
      additionalProperties: true,
    });
    const body: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"toString":false}',
    );
    expect(accepts(operation, { body })).toBe(true);
    expect({}).not.toHaveProperty("polluted");
  });
  it.each([
    { type: "string", minLength: "2" },
    { type: "number", minimum: "1" },
    { type: "array", items: true, minItems: -1 },
    { type: "number", multipleOf: 0 },
    { type: "object", required: "id" },
    { type: "object", properties: [] },
    { type: "array", items: 42 },
    { type: ["string", "string"] },
    { type: "other" },
    { anyOf: [] },
    { pattern: 42 },
  ])(
    "rejects malformed constraints instead of weakening them (%j)",
    (schema) => {
      expect(() => operationFor(schema)).toThrow(/Invalid (schema|nested)/);
    },
  );
  it("enforces structural object and primitive uniqueness", () => {
    const objects = operationFor({
      type: "array",
      uniqueItems: true,
      items: { type: "object" },
    });
    expect(accepts(objects, { body: [{ id: 1 }, { id: 1 }] })).toBe(false);
    expect(accepts(objects, { body: [{ id: 1 }, { id: 2 }] })).toBe(true);
    const operation = operationFor({
      type: "array",
      uniqueItems: true,
      items: { type: "string" },
    });
    expect(accepts(operation, { body: ["a", "a"] })).toBe(false);
    expect(accepts(operation, { body: ["a", "b"] })).toBe(true);
  });
  it("preserves OpenAPI 3.0 exclusive bounds and ignores reference siblings", () => {
    const operation = operationFor(
      { $ref: "#/components/schemas/Value", maximum: 0 },
      { Value: { type: "number", minimum: 1, exclusiveMinimum: true } },
      { openapi: "3.0.3" },
    );
    expect(accepts(operation, { body: 1 })).toBe(false);
    expect(accepts(operation, { body: 2 })).toBe(true);
  });
  it("keeps annotation payloads opaque rather than treating them as schemas", () => {
    const operation = operationFor({
      type: "object",
      default: { $ref: "https://example.com", required: "not a schema" },
      additionalProperties: true,
    });
    expect(accepts(operation, { body: {} })).toBe(true);
  });
  it("ignores unused unsupported components", () => {
    expect(
      accepts(
        operationFor({ type: "string" }, { Unused: { if: true, then: false } }),
        { body: "value" },
      ),
    ).toBe(true);
  });
  it.each([
    "/x/%2e%2E/value",
    "/x/.%2e/value",
    "/x\\value",
    "/x/{broken",
    "/x/ white",
  ])("rejects ambiguous API paths: %s", (path) => {
    expect(() =>
      compileOpenApi(
        document(
          {},
          {},
          { paths: { [path]: { get: { responses: API_RESPONSES } } } },
        ),
      ),
    ).toThrow();
  });
  it("overrides inherited headers without regard to case", () => {
    const catalog = compileOpenApi(
      document(
        {},
        {},
        {
          paths: {
            "/value": {
              parameters: [
                {
                  in: "header",
                  name: "X-Value",
                  required: true,
                  schema: { type: "integer" },
                },
              ],
              get: {
                parameters: [
                  { in: "header", name: "x-value", schema: { type: "string" } },
                ],
                responses: API_RESPONSES,
              },
            },
          },
        },
      ),
    );
    expect(catalog.operations[0]?.parameters).toHaveLength(1);
    const operation = catalog.operations[0];
    if (operation === undefined) {
      throw new Error("Missing test operation.");
    }
    expect(accepts(operation, { headers: { "x-value": "abc" } })).toBe(true);
    expect(accepts(operation, {})).toBe(true);
  });
  it.each(["2.0", "3.3.0", "3.1.invalid"])(
    "rejects unsupported OpenAPI versions: %s",
    (openapi) => {
      expect(() => compileOpenApi(document({}, {}, { openapi }))).toThrow(
        "Invalid OpenAPI document",
      );
    },
  );
});
