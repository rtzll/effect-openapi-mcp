import { Redacted } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { compileOpenApi } from "./openapi.ts";
import { accepts, API_RESPONSES, findOperation } from "./test-fixtures.ts";

const document = (
  operation: object = {},
  components: object = {},
  extra: object = {},
) => ({
  openapi: "3.2.1",
  servers: [{ url: "https://api.example.com/v1" }],
  components,
  paths: {
    "/public": { get: { responses: API_RESPONSES } },
    "/value": { query: { responses: API_RESPONSES, ...operation } },
  },
  ...extra,
});
const requestBody = (schema: object | boolean) => ({
  required: true,
  content: { "application/json": { schema } },
});

describe("OpenAPI 3.2 execution and compatibility", () => {
  it.each(["3.0.4", "3.1.2", "3.2.0", "3.2.1"])(
    "preserves bounded JSON inputs in %s",
    (openapi) => {
      const catalog = compileOpenApi(
        document(
          {},
          {},
          {
            openapi,
            paths: {
              "/value": {
                post: {
                  requestBody: requestBody({ type: "integer", minimum: 1 }),
                  responses: API_RESPONSES,
                },
              },
            },
          },
        ),
      );
      const operation = findOperation(catalog, "post_value");
      expect(accepts(operation, { body: 1 })).toBe(true);
      expect(accepts(operation, { body: 0 })).toBe(false);
      expect(accepts(operation, { body: "1" })).toBe(false);
    },
  );
  it.each(["3.2.0", "3.2.1"])(
    "supports safe, idempotent QUERY bodies and method filters in %s",
    (openapi) => {
      const catalog = compileOpenApi(
        document(
          {
            requestBody: requestBody({
              type: "object",
              properties: { count: { type: "integer", minimum: 1 } },
              required: ["count"],
              additionalProperties: false,
            }),
          },
          {},
          { openapi },
        ),
        { methods: ["query"] },
      );
      const operation = findOperation(catalog, "query_value");
      expect(operation.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      });
      expect(accepts(operation, { body: { count: 1 } })).toBe(true);
      expect(accepts(operation, { body: { count: 0 } })).toBe(false);
      expect(accepts(operation, {})).toBe(false);
      expect(catalog.filtered).toHaveLength(1);
      expect(catalog.unsupported).toEqual([]);
    },
  );
  it.each(["3.0.4", "3.1.2"])("diagnoses QUERY before 3.2 (%s)", (openapi) => {
    const catalog = compileOpenApi(document({}, {}, { openapi }));
    expect(catalog.unsupported).toEqual([
      {
        method: "query",
        path: "/value",
        reason: "QUERY requires OpenAPI 3.2.",
      },
    ]);
  });
  it.each([
    "https://spec.openapis.org/oas/3.2/dialect/2025-09-17",
    "https://spec.openapis.org/oas/3.2/dialect/2026-02-26",
  ])("honors document and schema dialect identifiers: %s", (dialect) => {
    for (const extra of [{ jsonSchemaDialect: dialect }, {}]) {
      const catalog = compileOpenApi(
        document(
          {
            requestBody: requestBody({
              $schema: dialect,
              $ref: "#/components/schemas/Value",
              maximum: 3,
            }),
          },
          { schemas: { Value: { type: "integer", minimum: 1 } } },
          extra,
        ),
      );
      const operation = findOperation(catalog, "query_value");
      expect(accepts(operation, { body: 2 })).toBe(true);
      expect(accepts(operation, { body: 0 })).toBe(false);
      expect(accepts(operation, { body: 4 })).toBe(false);
    }
  });
  it("rejects unknown schema dialects without weakening constraints", () => {
    const catalog = compileOpenApi(
      document({
        requestBody: requestBody({
          $schema: "https://spec.openapis.org/oas/3.2/dialect/2099-01-01",
          type: "string",
        }),
      }),
    );
    expect(catalog.unsupported[0]?.reason).toContain(
      "Unsupported JSON Schema dialect",
    );
  });
  it("does not let a supported document dialect hide an unsupported schema dialect", () => {
    const catalog = compileOpenApi(
      document(
        {
          requestBody: requestBody({
            $schema: "https://schemas.example.com/custom-dialect",
            type: "string",
          }),
        },
        {},
        {
          jsonSchemaDialect:
            "https://spec.openapis.org/oas/3.2/dialect/2026-02-26",
        },
      ),
    );
    expect(catalog.unsupported[0]?.reason).toContain(
      "Unsupported JSON Schema dialect",
    );
  });
  it.each(["3.2.0", "3.2.1"])(
    "allows omitted response declarations in %s",
    (openapi) => {
      const catalog = compileOpenApi({
        openapi,
        servers: [{ url: "https://api.example.com" }],
        paths: { "/value": { get: {} } },
      });
      expect(catalog.operations[0]?.responses).toEqual({});
      expect(catalog.operations[0]?.responseContentTypes).toEqual([]);
    },
  );
  it.each(["3.0.4", "3.1.2"])(
    "requires response declarations before 3.2 (%s)",
    (openapi) => {
      expect(() =>
        compileOpenApi({
          openapi,
          servers: [{ url: "https://api.example.com" }],
          paths: { "/value": { get: {} } },
        }),
      ).toThrow("must declare responses");
    },
  );
  it("resolves reusable media types without losing input validation", () => {
    const catalog = compileOpenApi(
      document(
        {
          requestBody: {
            required: true,
            content: {
              "application/json": { $ref: "#/components/mediaTypes/Alias" },
            },
          },
          responses: {
            "200": {
              content: {
                "application/json": { $ref: "#/components/mediaTypes/Payload" },
              },
            },
          },
        },
        {
          mediaTypes: {
            Alias: { $ref: "#/components/mediaTypes/Payload" },
            Payload: { schema: { $ref: "#/components/schemas/Value" } },
          },
          schemas: { Value: { type: ["integer", "null"], minimum: 1 } },
        },
      ),
    );
    const operation = findOperation(catalog, "query_value");
    expect(accepts(operation, { body: 2 })).toBe(true);
    expect(accepts(operation, { body: null })).toBe(true);
    expect(accepts(operation, { body: 0 })).toBe(false);
    expect(operation.responseContentTypes).toEqual(["application/json"]);
  });
  it.each([
    { $ref: "#/components/mediaTypes/Missing" },
    { $ref: "https://schemas.example.com/media.json" },
    { $ref: "#/components/mediaTypes/Cyclic" },
  ])(
    "diagnoses unresolved, external or cyclic media references (%j)",
    (media) => {
      for (const direction of ["request", "response"]) {
        const catalog = compileOpenApi(
          document(
            direction === "request"
              ? { requestBody: { content: { "application/json": media } } }
              : {
                  responses: {
                    "200": { content: { "application/json": media } },
                  },
                },
            {
              mediaTypes: {
                Cyclic: { $ref: "#/components/mediaTypes/Cyclic" },
              },
            },
          ),
        );
        expect(catalog.unsupported).toHaveLength(1);
        expect(catalog.operations.map((operation) => operation.name)).toEqual([
          "get_public",
        ]);
      }
    },
  );
  it("keeps API server resolution tied to the retrieval URL, independently of $self", () => {
    const catalog = compileOpenApi(
      document(
        {},
        {},
        {
          $self: "https://schemas.example.com/catalog/openapi.yaml",
          servers: [{ url: "./api" }],
        },
      ),
      { sourceUrl: new URL("https://retrieval.example.com/docs/openapi.yaml") },
    );
    expect(findOperation(catalog, "query_value").baseUrl.href).toBe(
      "https://retrieval.example.com/docs/api/",
    );
  });
  it("supports fragment-form security requirements and removes credential inputs", () => {
    const reference = "#/components/securitySchemes/Key";
    const catalog = compileOpenApi(
      document(
        {
          security: [{ [reference]: [] }],
          parameters: [
            { in: "query", name: "api_key", schema: { type: "string" } },
          ],
        },
        {
          securitySchemes: {
            Key: { type: "apiKey", in: "query", name: "api_key" },
          },
        },
      ),
      {
        credentials: { [reference]: Redacted.make("private-fragment-key") },
      },
    );
    const operation = findOperation(catalog, "query_value");
    expect(operation.authentication[0]?.value).toEqual(
      Redacted.make("private-fragment-key"),
    );
    expect(accepts(operation, { query: { api_key: "override" } })).toBe(false);
    expect(JSON.stringify(catalog)).not.toContain("private-fragment-key");
  });
  it("diagnoses external security requirement URIs", () => {
    const catalog = compileOpenApi(
      document({
        security: [{ "https://schemas.example.com/auth": [] }],
      }),
    );
    expect(catalog.unsupported[0]?.reason).toContain(
      "unsupported external security reference",
    );
  });
  it("binds externally acquired OAuth device-flow tokens", () => {
    const catalog = compileOpenApi(
      document(
        { security: [{ Device: ["read"] }] },
        {
          securitySchemes: {
            Device: {
              type: "oauth2",
              flows: {
                deviceAuthorization: {
                  deviceAuthorizationUrl: "https://auth.example.com/device",
                  tokenUrl: "https://auth.example.com/token",
                  scopes: { read: "Read values" },
                },
              },
              oauth2MetadataUrl:
                "https://auth.example.com/.well-known/oauth-authorization-server",
            },
          },
        },
      ),
      { credentials: { Device: Redacted.make("opaque-device-token") } },
    );
    expect(
      findOperation(catalog, "query_value").authentication[0]?.value,
    ).toEqual(Redacted.make("Bearer opaque-device-token"));
  });
  it.each(["operation", "path"])(
    "diagnoses whole-query-string parameters at %s level",
    (level) => {
      const parameters = [
        {
          in: "querystring",
          name: "filter",
          content: { "application/json": { schema: { type: "object" } } },
        },
      ];
      const catalog = compileOpenApi(
        document(
          {},
          {},
          {
            paths: {
              "/public": { get: { responses: API_RESPONSES } },
              "/value": {
                ...(level === "path" ? { parameters } : {}),
                get: {
                  responses: API_RESPONSES,
                  ...(level === "operation" ? { parameters } : {}),
                },
              },
            },
          },
        ),
      );
      expect(catalog.unsupported[0]?.reason).toContain("in: querystring");
      expect(catalog.operations).toHaveLength(1);
    },
  );
  it("does not discard content-based parameter serialization", () => {
    const catalog = compileOpenApi(
      document({
        parameters: [
          {
            in: "query",
            name: "filter",
            schema: { type: "string" },
            content: { "application/json": { schema: { type: "string" } } },
          },
        ],
      }),
    );
    expect(catalog.unsupported[0]?.reason).toContain(
      "Content-based parameter serialization",
    );
  });
  it("accounts for custom methods and invalid fixed-method duplicates", () => {
    const catalog = compileOpenApi(
      document(
        {},
        {},
        {
          paths: {
            "/public": { get: { responses: API_RESPONSES } },
            "/value": {
              additionalOperations: {
                COPY: {},
                PROPFIND: {},
                GET: {},
                QUERY: {},
              },
            },
          },
        },
      ),
    );
    expect(catalog.unsupported.map((diagnostic) => diagnostic.method)).toEqual([
      "COPY",
      "GET",
      "PROPFIND",
      "QUERY",
    ]);
    expect(
      catalog.unsupported.filter((diagnostic) =>
        diagnostic.reason.includes("fixed Path Item field"),
      ),
    ).toHaveLength(2);
    expect(catalog.operations).toHaveLength(1);
  });
  it("includes custom operations in filter diagnostics", () => {
    const catalog = compileOpenApi(
      document(
        {},
        {},
        {
          paths: {
            "/public": { get: { responses: API_RESPONSES } },
            "/value": { additionalOperations: { COPY: {} } },
          },
        },
      ),
      { methods: ["get"] },
    );
    expect(catalog.filtered).toEqual([
      {
        method: "COPY",
        path: "/value",
        reason: "Excluded by the method filter.",
      },
    ]);
    expect(catalog.unsupported).toEqual([]);
  });
  it("filters custom operations by their own tags without expanding parent tags", () => {
    const catalog = compileOpenApi(
      document(
        {},
        {},
        {
          tags: [
            { name: "public" },
            { name: "child", parent: "public", kind: "nav" },
          ],
          paths: {
            "/public": { get: { tags: ["public"], responses: API_RESPONSES } },
            "/child": { get: { tags: ["child"], responses: API_RESPONSES } },
            "/value": { additionalOperations: { COPY: { tags: ["child"] } } },
          },
        },
      ),
      { tags: ["public"] },
    );
    expect(catalog.operations.map((operation) => operation.name)).toEqual([
      "get_public",
    ]);
    expect(catalog.filtered).toHaveLength(2);
    expect(catalog.unsupported).toEqual([]);
  });
  it.each([
    "application/jsonl",
    "application/json-seq",
    "text/event-stream",
    "multipart/mixed",
  ])(
    "diagnoses unsupported sequential media rather than treating it as JSON: %s",
    (type) => {
      const catalog = compileOpenApi(
        document({
          requestBody: {
            content: { [type]: { itemSchema: { type: "integer" } } },
          },
        }),
      );
      expect(catalog.unsupported[0]?.reason).toContain(
        "Unsupported request media type",
      );
    },
  );
  it.each(["request", "response"])(
    "does not discard itemSchema from %s media",
    (direction) => {
      const media = { "application/json": { itemSchema: { type: "integer" } } };
      const catalog = compileOpenApi(
        document(
          direction === "request"
            ? { requestBody: { content: media } }
            : { responses: { "200": { content: media } } },
        ),
      );
      expect(catalog.unsupported[0]?.reason).toContain("itemSchema");
    },
  );
  it("selects ordinary JSON when a streaming response is also declared", () => {
    const catalog = compileOpenApi(
      document({
        responses: {
          "200": {
            content: {
              "application/x-ndjson": { itemSchema: { type: "integer" } },
              "application/json": {
                schema: { type: "array", items: { type: "integer" } },
              },
            },
          },
        },
      }),
    );
    expect(findOperation(catalog, "query_value").responseContentTypes).toEqual([
      "application/json",
    ]);
    expect(catalog.unsupported).toEqual([]);
  });
});
