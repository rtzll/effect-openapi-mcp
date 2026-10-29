import { Redacted } from "effect";
import { Tool } from "effect/ai";
import { describe, expect, it } from "vite-plus/test";
import { analyzeOpenApi, compileOpenApi } from "./openapi.ts";
import {
  accepts,
  API_RESPONSES,
  findOperation,
  inventoryCatalog,
  INVENTORY_SPEC,
  TEST_CREDENTIALS,
  TICKETING_SPEC,
} from "./test-fixtures.ts";

const spec = (paths: object, components: object = {}) => ({
  openapi: "3.1.0",
  servers: [{ url: "https://api.example.com/v1" }],
  paths,
  components,
});
const get = (overrides: object = {}) => ({
  responses: API_RESPONSES,
  ...overrides,
});
const inputSchema = (operation: ReturnType<typeof findOperation>) =>
  Tool.getJsonSchema(
    Tool.dynamic(operation.name, { parameters: operation.parametersSchema }),
  );

describe("Generic OpenAPI compiler", () => {
  it("analyzes empty and completely filtered catalogs while startup remains strict", () => {
    expect(analyzeOpenApi(spec({}))).toEqual({
      operations: [],
      unsupported: [],
      filtered: [],
    });
    const filtered = analyzeOpenApi(INVENTORY_SPEC, {
      credentials: TEST_CREDENTIALS,
      tags: ["absent"],
    });
    expect(filtered.operations).toEqual([]);
    expect(filtered.unsupported).toEqual([]);
    expect(filtered.filtered).toHaveLength(6);
    expect(
      filtered.filtered.every((item) => item.reason.includes("tag filter")),
    ).toBe(true);
    expect(() => compileOpenApi(INVENTORY_SPEC, { tags: ["absent"] })).toThrow(
      "6 filtered, 0 unsupported",
    );
    expect(() => compileOpenApi(INVENTORY_SPEC, { tags: ["absent"] })).toThrow(
      "Excluded by the tag filter",
    );
  });
  it("analyzes unsupported operations without exposing an unusable runtime catalog", () => {
    const document = spec({
      "/upload": {
        post: get({
          requestBody: { content: { "multipart/form-data": {} } },
        }),
      },
    });
    const catalog = analyzeOpenApi(document);
    expect(catalog.operations).toEqual([]);
    expect(catalog.unsupported).toHaveLength(1);
    expect(catalog.filtered).toEqual([]);
    expect(() => compileOpenApi(document)).toThrow("0 filtered, 1 unsupported");
    expect(() => compileOpenApi(document)).toThrow(
      catalog.unsupported[0]?.reason,
    );
  });
  it("generates every supported operation without handwritten registrations", () => {
    const catalog = inventoryCatalog();
    expect(catalog.operations.map((operation) => operation.name)).toEqual([
      "list_items",
      "create_item",
      "get_item",
      "update_item",
      "delete_item",
      "search_items",
    ]);
    expect(catalog.unsupported).toEqual([]);
    expect(catalog.filtered).toEqual([]);
    expect(inputSchema(findOperation(catalog, "get_item"))).toHaveProperty(
      "properties.path.required",
      ["id"],
    );
    expect(inputSchema(findOperation(catalog, "list_items"))).toHaveProperty(
      "properties.query.properties.limit.default",
      20,
    );
    expect(
      inputSchema(findOperation(catalog, "create_item")),
    ).not.toHaveProperty("$defs.Unused");
  });
  it("supports an unrelated OpenAPI 3.0 bearer API", () => {
    const catalog = compileOpenApi(TICKETING_SPEC, {
      credentials: { AccessToken: Redacted.make("test-token") },
    });
    expect(catalog.operations.map((operation) => operation.name)).toEqual([
      "create_ticket",
      "get_ticket",
    ]);
    const operation = findOperation(catalog, "create_ticket");
    expect(
      accepts(operation, { body: { subject: "Question", assignee: null } }),
    ).toBe(true);
    expect(
      accepts(operation, { body: { subject: "Question", assignee: 42 } }),
    ).toBe(false);
    expect(operation.authentication[0]).toHaveProperty(
      "value",
      Redacted.make("Bearer test-token"),
    );
  });
  it("filters by method and tag without endpoint-specific classifications", () => {
    expect(
      inventoryCatalog({ methods: ["get"] }).operations.map(
        (operation) => operation.name,
      ),
    ).toEqual(["list_items", "get_item"]);
    expect(
      inventoryCatalog({ tags: ["search"] }).operations.map(
        (operation) => operation.name,
      ),
    ).toEqual(["search_items"]);
    expect(
      findOperation(inventoryCatalog(), "search_items").annotations
        .readOnlyHint,
    ).toBe(false);
    expect(inventoryCatalog({ methods: ["get"] }).filtered).toHaveLength(4);
  });
  it("honors generic spec annotations independently of filtering", () => {
    const catalog = compileOpenApi(
      spec({
        "/search": { post: get({ "x-mcp-read-only": true }) },
        "/side-effects": { get: get({ "x-mcp-read-only": false }) },
        "/replace": { put: get() },
      }),
    );
    expect(findOperation(catalog, "post_search").annotations.readOnlyHint).toBe(
      true,
    );
    expect(
      findOperation(catalog, "get_side_effects").annotations.readOnlyHint,
    ).toBe(false);
    expect(
      findOperation(catalog, "put_replace").annotations.idempotentHint,
    ).toBe(true);
  });
  it.each([null, "ACTIVE", "ARCHIVED"])(
    "imports nullable enum intersections without API-specific rules (%s)",
    (state) => {
      const operation = findOperation(inventoryCatalog(), "create_item");
      expect(accepts(operation, { body: { label: "Item", state } })).toBe(true);
      expect(
        accepts(operation, { body: { label: "Item", state: "UNKNOWN" } }),
      ).toBe(false);
      expect(accepts(operation, { body: { label: "Item", state: 1 } })).toBe(
        false,
      );
      expect(accepts(operation, { body: { label: "Item" } })).toBe(false);
    },
  );
  it("validates bounds, patterns, required groups and excess properties strictly", () => {
    const catalog = inventoryCatalog();
    expect(
      accepts(findOperation(catalog, "list_items"), {
        query: { limit: 5, after: null },
      }),
    ).toBe(true);
    expect(
      accepts(findOperation(catalog, "list_items"), { query: { limit: 101 } }),
    ).toBe(false);
    expect(
      accepts(findOperation(catalog, "list_items"), { query: { limit: "5" } }),
    ).toBe(false);
    expect(
      accepts(findOperation(catalog, "list_items"), {
        query: { unsupported: true },
      }),
    ).toBe(false);
    expect(
      accepts(findOperation(catalog, "get_item"), { path: { id: "invalid" } }),
    ).toBe(false);
    expect(accepts(findOperation(catalog, "get_item"), {})).toBe(false);
    expect(
      accepts(findOperation(catalog, "get_item"), {
        path: { id: "it_1" },
        extra: true,
      }),
    ).toBe(false);
  });
  it("resolves parameter, body and response components and recursive schemas", () => {
    const catalog = compileOpenApi(
      spec(
        {
          "/trees/{id}": {
            parameters: [{ $ref: "#/components/parameters/Id" }],
            post: get({
              requestBody: { $ref: "#/components/requestBodies/Body" },
              responses: { "200": { $ref: "#/components/responses/Result" } },
            }),
          },
        },
        {
          parameters: {
            Id: {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string", minLength: 4 },
            },
          },
          requestBodies: {
            Body: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Node" },
                },
              },
            },
          },
          responses: { Result: { content: { "application/json": {} } } },
          schemas: {
            Node: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                child: {
                  anyOf: [
                    { $ref: "#/components/schemas/Node" },
                    { type: "null" },
                  ],
                },
              },
            },
          },
        },
      ),
    );
    const operation = findOperation(catalog, "post_trees_by_id");
    expect(
      accepts(operation, {
        path: { id: "tree-1" },
        body: { name: "Root", child: { name: "Child", child: null } },
      }),
    ).toBe(true);
    expect(
      accepts(operation, { path: { id: "x" }, body: { name: "Root" } }),
    ).toBe(false);
    expect(
      accepts(operation, { path: { id: "tree-1" }, body: { child: null } }),
    ).toBe(false);
  });
  it("preserves literals inside defaults and examples", () => {
    const body = {
      content: {
        "application/json": {
          schema: {
            type: "object",
            default: { $ref: "literal-data" },
            examples: [{ $ref: "also-literal" }],
          },
        },
      },
    };
    const operation = findOperation(
      compileOpenApi(spec({ "/items": { post: get({ requestBody: body }) } })),
      "post_items",
    );
    const schema = inputSchema(operation);
    expect(schema).toHaveProperty(
      "properties.body.default.$ref",
      "literal-data",
    );
    expect(schema).toHaveProperty(
      "properties.body.examples.0.$ref",
      "also-literal",
    );
  });
  it("selects operation, path, then document servers and expands server variables", () => {
    const catalog = compileOpenApi({
      ...spec({
        "/document": { get: get() },
        "/path": {
          servers: [
            {
              url: "https://path.example.com/{version}",
              variables: { version: { default: "v2" } },
            },
          ],
          get: get(),
        },
        "/operation": {
          servers: [{ url: "https://path.example.com/" }],
          get: get({ servers: [{ url: "https://operation.example.com/v3" }] }),
        },
      }),
    });
    expect(findOperation(catalog, "get_document").baseUrl.href).toBe(
      "https://api.example.com/v1/",
    );
    expect(findOperation(catalog, "get_path").baseUrl.href).toBe(
      "https://path.example.com/v2/",
    );
    expect(findOperation(catalog, "get_operation").baseUrl.href).toBe(
      "https://operation.example.com/v3/",
    );
    const override = compileOpenApi(INVENTORY_SPEC, {
      credentials: TEST_CREDENTIALS,
      baseUrl: new URL("https://staging.example.com/api"),
    });
    expect(
      override.operations.every(
        (operation) =>
          operation.baseUrl.href === "https://staging.example.com/api/",
      ),
    ).toBe(true);
  });
  it("resolves relative server URLs against remote spec locations", () => {
    const catalog = compileOpenApi(
      { ...spec({ "/items": { get: get() } }), servers: [{ url: "/v2" }] },
      { sourceUrl: new URL("https://api.example.com/docs/spec.json") },
    );
    expect(findOperation(catalog, "get_items").baseUrl.href).toBe(
      "https://api.example.com/v2/",
    );
  });
  it("derives stable names and rejects duplicates", () => {
    const detail = {
      get: get({
        parameters: [{ in: "path", name: "id", schema: { type: "string" } }],
      }),
    };
    const a = { "/items/{id}": detail, "/items": { get: get() } };
    const b = { "/items": { get: get() }, "/items/{id}": detail };
    expect(
      compileOpenApi(spec(a)).operations.map((operation) => operation.name),
    ).toEqual(["get_items", "get_items_by_id"]);
    expect(
      compileOpenApi(spec(a)).operations.map((operation) => operation.name),
    ).toEqual(
      compileOpenApi(spec(b)).operations.map((operation) => operation.name),
    );
    expect(() =>
      compileOpenApi(
        spec({
          "/a": { get: get({ operationId: "same" }) },
          "/b": { get: get({ operationId: "same" }) },
        }),
      ),
    ).toThrow("Duplicate MCP tool name");
  });
  it.each([{ type: "null" }, { type: "string", nullable: true }])(
    "diagnoses array parameter items without a supported HTTP representation (%j)",
    (items) => {
      const catalog = compileOpenApi(
        spec({
          "/supported": { get: get() },
          "/nullable-items": {
            get: get({
              parameters: [
                {
                  in: "query",
                  name: "values",
                  schema: { type: "array", items },
                },
              ],
            }),
          },
        }),
      );
      expect(catalog.operations).toHaveLength(1);
      expect(catalog.unsupported).toEqual([
        {
          method: "get",
          path: "/nullable-items",
          reason: "Nullable array parameter items are not supported.",
        },
      ]);
    },
  );
  it.each([
    [
      "malformed component reference",
      { requestBody: { $ref: "#/components/requestBodies/%ZZ" } },
    ],
    [
      "malformed array item schema",
      {
        parameters: [
          { in: "query", name: "values", schema: { type: "array", items: 42 } },
        ],
      },
    ],
    [
      "malformed parameter union",
      { parameters: [{ in: "query", name: "value", schema: { anyOf: [42] } }] },
    ],
    [
      "object parameter",
      {
        parameters: [
          { in: "query", name: "filter", schema: { type: "object" } },
        ],
      },
    ],
    [
      "unsupported serialization",
      {
        parameters: [
          {
            in: "query",
            name: "filter",
            style: "unknown-style",
            schema: { type: "string" },
          },
        ],
      },
    ],
    [
      "reserved header",
      {
        parameters: [
          { in: "header", name: "Host", schema: { type: "string" } },
        ],
      },
    ],
    [
      "external reference",
      {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "https://example.com/schema" },
            },
          },
        },
      },
    ],
    [
      "unresolved reference",
      {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Missing" },
            },
          },
        },
      },
    ],
    [
      "multipart body",
      {
        requestBody: {
          content: { "multipart/form-data": { schema: { type: "object" } } },
        },
      },
    ],
    [
      "streaming response",
      { responses: { "200": { content: { "application/jsonl": {} } } } },
    ],
    [
      "unsupported conditional",
      {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                if: { required: ["a"] },
                then: { required: ["b"] },
              },
            },
          },
        },
      },
    ],
  ])("diagnoses an unsupported %s without exposing it", (_name, overrides) => {
    const catalog = compileOpenApi(
      spec({
        "/supported": { get: get() },
        "/unsupported": { post: get(overrides) },
      }),
    );
    expect(catalog.operations.map((operation) => operation.name)).toEqual([
      "get_supported",
    ]);
    expect(catalog.unsupported).toHaveLength(1);
    expect(catalog.unsupported[0]).toMatchObject({
      method: "post",
      path: "/unsupported",
    });
    expect(catalog.unsupported[0]?.reason).not.toBe("");
  });
  it("binds AND requirements and selects configured OR alternatives", () => {
    const catalog = compileOpenApi(
      spec(
        {
          "/both": { get: get({ security: [{ Key: [], Token: [] }] }) },
          "/either": { get: get({ security: [{ Missing: [] }, { Key: [] }] }) },
          "/public": { get: get({ security: [] }) },
        },
        {
          securitySchemes: {
            Key: { type: "apiKey", in: "header", name: "X-Key" },
            Token: { type: "http", scheme: "bearer" },
          },
        },
      ),
      {
        credentials: {
          Key: Redacted.make("key"),
          Token: Redacted.make("token"),
        },
      },
    );
    expect(
      findOperation(catalog, "get_both").authentication.map(
        (binding) => binding.name,
      ),
    ).toEqual(["X-Key", "Authorization"]);
    expect(findOperation(catalog, "get_either").authentication).toHaveLength(1);
    expect(findOperation(catalog, "get_public").authentication).toHaveLength(0);
  });
  it("removes credential parameters from schemas and never bypasses missing authentication", () => {
    const catalog = compileOpenApi(
      spec(
        {
          "/private": {
            get: get({
              security: [{ Key: [] }],
              parameters: [
                {
                  in: "query",
                  name: "api_key",
                  required: true,
                  schema: { type: "string" },
                },
              ],
            }),
          },
          "/missing": { get: get({ security: [{ Missing: [] }] }) },
        },
        {
          securitySchemes: {
            Key: { type: "apiKey", in: "query", name: "api_key" },
            Missing: { type: "apiKey", in: "header", name: "X-Missing" },
          },
        },
      ),
      { credentials: TEST_CREDENTIALS },
    );
    expect(
      inputSchema(findOperation(catalog, "get_private")),
    ).not.toHaveProperty("properties.query");
    expect(catalog.unsupported[0]?.reason).toContain("Missing credential");
    expect(JSON.stringify(catalog)).not.toContain("private-upstream-test-key");
  });
  it.each([
    ["invalid version", { openapi: "2.0", paths: {} }],
    ["no operations", spec({})],
    ["missing path parameter", spec({ "/items/{id}": { get: get() } })],
    [
      "missing API server",
      { openapi: "3.1.0", paths: { "/items": { get: get() } } },
    ],
    [
      "unsafe server",
      {
        ...spec({ "/items": { get: get() } }),
        servers: [{ url: "https://user:secret@api.example.com/" }],
      },
    ],
  ])("rejects %s", (_name, value) =>
    expect(() => compileOpenApi(value)).toThrow(),
  );
  it("keeps credentials for every security alternative out of tool inputs", () => {
    const catalog = compileOpenApi(
      spec(
        {
          "/items": {
            get: get({
              security: [{ Token: [] }, { Key: [] }],
              parameters: [
                { in: "header", name: "X-Key", schema: { type: "string" } },
              ],
            }),
          },
        },
        {
          securitySchemes: {
            Token: { type: "http", scheme: "bearer" },
            Key: { type: "apiKey", in: "header", name: "X-Key" },
          },
        },
      ),
      { credentials: { Token: Redacted.make("token") } },
    );
    const operation = findOperation(catalog, "get_items");
    expect(inputSchema(operation)).not.toHaveProperty("properties.headers");
    expect(operation.authentication.map((binding) => binding.name)).toEqual([
      "Authorization",
    ]);
  });
  it.each([
    [
      "before the configured alternative",
      [{ Broken: [] }, { Key: [] }, { Other: [] }],
      ["api_key"],
    ],
    [
      "after the configured alternative",
      [{ Key: [] }, { Broken: [] }, { Other: [] }],
      ["api_key"],
    ],
    [
      "before anonymous access",
      [{ Broken: [] }, {}, { Key: [] }, { Other: [] }],
      [],
    ],
    [
      "after anonymous access",
      [{}, { Broken: [] }, { Key: [] }, { Other: [] }],
      [],
    ],
  ])(
    "skips unsupported security references %s when filtering parameters",
    (_name, security, authenticationNames) => {
      const catalog = compileOpenApi(
        spec(
          {
            "/items": {
              get: get({
                security,
                parameters: [
                  { in: "query", name: "search", schema: { type: "string" } },
                  {
                    in: "query",
                    name: "api_key",
                    required: true,
                    schema: { type: "string" },
                  },
                  {
                    in: "header",
                    name: "X-Other",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
              }),
            },
          },
          {
            securitySchemes: {
              Broken: { $ref: "https://example.com/security.json#/Key" },
              Key: { type: "apiKey", in: "query", name: "api_key" },
              Other: { type: "apiKey", in: "header", name: "X-Other" },
            },
          },
        ),
        { credentials: { Key: Redacted.make("key") } },
      );
      const operation = findOperation(catalog, "get_items");
      expect(catalog.unsupported).toEqual([]);
      expect(operation.parameters).toEqual([
        {
          name: "search",
          location: "query",
          encoding: { style: "form", explode: true },
        },
      ]);
      expect(inputSchema(operation)).not.toHaveProperty("properties.headers");
      expect(inputSchema(operation)).not.toHaveProperty(
        "properties.query.properties.api_key",
      );
      expect(accepts(operation, { query: { search: "value" } })).toBe(true);
      expect(operation.authentication.map((binding) => binding.name)).toEqual(
        authenticationNames,
      );
    },
  );
  it("does not bypass an unsupported security reference without a usable alternative", () => {
    const catalog = analyzeOpenApi(
      spec(
        {
          "/items": {
            get: get({
              security: [{ Broken: [] }],
              parameters: [
                { in: "query", name: "search", schema: { type: "string" } },
              ],
            }),
          },
        },
        {
          securitySchemes: {
            Broken: { $ref: "https://example.com/security.json#/Key" },
          },
        },
      ),
    );
    expect(catalog.operations).toEqual([]);
    expect(catalog.unsupported).toEqual([
      {
        method: "get",
        path: "/items",
        reason: "Unsupported reference: https://example.com/security.json#/Key",
      },
    ]);
  });
});

describe("Public-corpus regressions", () => {
  it.each(["3.0.4", "3.1.2", "3.2.1"])(
    "accepts empty relative server URLs in %s",
    (openapi) => {
      const document = {
        ...spec({ "/items": { get: get({ servers: [{ url: "" }] }) } }),
        openapi,
      };
      const overridden = compileOpenApi(document, {
        baseUrl: new URL("https://mock.example.com/v1/"),
      });
      expect(overridden.operations[0]?.baseUrl.href).toBe(
        "https://mock.example.com/v1/",
      );
      const relative = compileOpenApi(document, {
        sourceUrl: new URL("https://api.example.com/docs/spec.json"),
      });
      expect(relative.operations[0]?.baseUrl.href).toBe(
        "https://api.example.com/docs/spec.json/",
      );
    },
  );
  it.each(["3.0.4", "3.1.2", "3.2.1"])(
    "never exposes unresolved operation references in %s",
    (openapi) => {
      const catalog = compileOpenApi({
        ...spec({
          "/items": { get: get() },
          "/unresolved": { get: { $ref: "resources/list.yaml" } },
        }),
        openapi,
      });
      expect(catalog.operations).toHaveLength(1);
      expect(catalog.unsupported).toEqual([
        {
          method: "get",
          path: "/unresolved",
          reason:
            "Referenced operations are not supported; supply a bundled OpenAPI document.",
        },
      ]);
    },
  );
  it("explains the unsupported Swagger format", () => {
    expect(() => compileOpenApi({ swagger: "2.0", paths: {} })).toThrow(
      "Swagger documents are not supported; use OpenAPI 3.0, 3.1 or 3.2.",
    );
  });
});
