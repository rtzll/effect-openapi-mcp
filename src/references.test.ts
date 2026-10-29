import { Data, Effect, Redacted, Schema } from "effect";
import { expect, it } from "@effect/vitest";
import {
  bundleOpenApi,
  ReferenceError,
  type ReferenceOptions,
} from "./references.ts";
import { compileOpenApi } from "./openapi.ts";
import type { JsonObject, JsonValue } from "./openapi-types.ts";
import { accepts } from "./test-fixtures.ts";

const SOURCE = new URL("https://spec.example.test/specs/openapi.yaml");
const NONE = { mode: "none", maxDocuments: 16, maxDepth: 16 } as const;
const LOCAL = { ...NONE, mode: "local" } as const;
const REMOTE = { ...NONE, mode: "same-origin" } as const;
const RESPONSES = { "200": { content: { "application/json": {} } } };
const document = (
  schema: JsonValue,
  components: JsonObject = {},
  version = "3.1.0",
): JsonObject => ({
  openapi: version,
  servers: [{ url: "https://api.example.test" }],
  paths: {
    "/items": {
      post: {
        operationId: "create_item",
        requestBody: {
          required: true,
          content: { "application/json": { schema } },
        },
        responses: RESPONSES,
      },
    },
  },
  components,
});
const loader =
  (sources: Readonly<Record<string, JsonValue>>, requested: string[] = []) =>
  (source: URL) =>
    Effect.suspend(() => {
      requested.push(source.href);
      const value = Object.hasOwn(sources, source.href)
        ? sources[source.href]
        : undefined;
      return value === undefined
        ? Effect.die("An unexpected document was requested.")
        : Effect.succeed(value);
    });
const bundle = (
  entry: JsonValue,
  options: ReferenceOptions = NONE,
  sources: Readonly<Record<string, JsonValue>> = {},
  source = SOURCE,
) => bundleOpenApi(entry, source, loader(sources), options);
const operation = (entry: JsonValue) => {
  const result = compileOpenApi(entry).operations[0];
  if (result === undefined) throw new Error("Missing compiled operation.");
  return result;
};
const definitions = (entry: JsonValue): JsonObject => {
  const object = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.MutableJson),
  )(entry);
  const components = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.MutableJson),
  )(object.components);
  return Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.MutableJson),
  )(components.schemas);
};

it.effect.each<JsonObject>([
  { url: "https://" },
  { url: "https://{missing}" },
  { url: "mailto:api@example.test" },
])(
  "defers absolute server validation to the operation compiler: $url",
  (server) =>
    Effect.gen(function* () {
      const entry: JsonObject = {
        openapi: "3.1.0",
        servers: [{ url: "https://api.example.test" }],
        paths: {
          "/good": { get: { responses: RESPONSES } },
          "/bad": { get: { servers: [server], responses: RESPONSES } },
        },
      };
      const bundled = yield* bundle(entry);
      expect(bundled).toEqual(entry);
      const catalog = compileOpenApi(bundled);
      expect(catalog.operations.map((operation) => operation.path)).toEqual([
        "/good",
      ]);
      expect(catalog.unsupported).toHaveLength(1);
      expect(catalog.unsupported[0]?.path).toBe("/bad");
      expect(catalog.unsupported[0]?.reason).toContain("Invalid API server:");
      const overridden = compileOpenApi(bundled, {
        baseUrl: new URL("https://override.example.test/"),
      });
      expect(overridden.operations).toHaveLength(2);
      expect(overridden.unsupported).toEqual([]);
      expect(
        overridden.operations.every(
          (operation) =>
            operation.baseUrl.href === "https://override.example.test/",
        ),
      ).toBe(true);
    }),
);

it.effect("rejects relative server URLs that cannot be rebased", () =>
  Effect.gen(function* () {
    const entry = {
      ...document({ type: "string" }),
      servers: [{ url: "//[invalid" }],
    };
    const error = yield* Effect.flip(bundle(entry));
    expect(error).toBeInstanceOf(ReferenceError);
    expect(error.message).toContain("A referenced API server URL is invalid");
  }),
);

it.effect.each(["3.0.3", "3.1.0", "3.2.1"])(
  "retains ordinary root schema component contracts (%s)",
  (version) =>
    Effect.gen(function* () {
      const entry = document(
        { $ref: "#/components/schemas/Item" },
        { schemas: { Item: { type: "string", minLength: 2 } } },
        version,
      );
      const bundled = yield* bundle(entry);
      expect(bundled).toEqual(entry);
      expect(accepts(operation(bundled), { body: "ok" })).toBe(true);
      expect(accepts(operation(bundled), { body: "x" })).toBe(false);
    }),
);

it.effect.each<[string, JsonObject]>([
  [
    "#/components/schemas/A/properties/value",
    {
      schemas: {
        A: {
          type: "object",
          properties: { value: { type: "integer", minimum: 2 } },
        },
      },
    },
  ],
  [
    "#/components/schemas/A~1B~0C",
    { schemas: { "A/B~C": { type: "integer", minimum: 2 } } },
  ],
  ["#/x-values/0", { "x-values": [{ type: "integer", minimum: 2 }] }],
  [
    "#/components/schemas/A/allOf/0",
    { schemas: { A: { allOf: [{ type: "integer", minimum: 2 }] } } },
  ],
  [
    "#/components/schemas/A/$defs/Value",
    { schemas: { A: { $defs: { Value: { type: "integer", minimum: 2 } } } } },
  ],
  [
    "#/components/schemas/A%25B",
    { schemas: { "A%B": { type: "integer", minimum: 2 } } },
  ],
])(
  "supports escaped and deep same-document JSON Pointers (%s)",
  ([reference, components]) =>
    Effect.gen(function* () {
      const entry = document({ $ref: reference }, components);
      if (reference.startsWith("#/x-values/"))
        entry["x-values"] = [{ type: "integer", minimum: 2 }];
      const bundled = yield* bundle(entry);
      expect(accepts(operation(bundled), { body: 2 })).toBe(true);
      expect(accepts(operation(bundled), { body: 1 })).toBe(false);
    }),
);

it.effect(
  "lifts embedded definitions on demand without importing unused definitions",
  () =>
    Effect.gen(function* () {
      const entry = document({
        type: "object",
        $defs: {
          Value: { type: "string", minLength: 2 },
          Unused: { $ref: "https://other.example.test/missing" },
        },
        properties: {
          value: {
            $ref: "#/paths/~1items/post/requestBody/content/application~1json/schema/$defs/Value",
          },
        },
        required: ["value"],
        additionalProperties: false,
      });
      const bundled = yield* bundle(entry);
      expect(accepts(operation(bundled), { body: { value: "ok" } })).toBe(true);
      expect(accepts(operation(bundled), { body: { value: "x" } })).toBe(false);
      expect(Object.keys(definitions(bundled))).toHaveLength(1);
    }),
);

it.effect(
  "retains recursive schema references and native validation/export",
  () =>
    Effect.gen(function* () {
      const entry = document(
        { $ref: "#/components/schemas/Tree" },
        {
          schemas: {
            Tree: {
              type: "object",
              properties: {
                label: { type: "string", minLength: 1 },
                children: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Tree" },
                },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
      );
      const bundled = yield* bundle(entry);
      const compiled = operation(bundled);
      expect(
        accepts(compiled, {
          body: { label: "root", children: [{ label: "child" }] },
        }),
      ).toBe(true);
      expect(
        accepts(compiled, {
          body: { label: "root", children: [{ label: "" }] },
        }),
      ).toBe(false);
      expect(() =>
        Schema.toJsonSchemaDocument(compiled.parametersSchema),
      ).not.toThrow();
      expect(Object.keys(definitions(bundled))).toEqual(["Tree"]);
    }),
);

it.effect(
  "caches parsed external documents and preserves mutually recursive external schemas",
  () =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const schema = {
        type: "object",
        properties: {
          first: { $ref: "./a.json" },
          second: { $ref: "./a.json" },
        },
        required: ["first"],
        additionalProperties: false,
      };
      const sources = {
        "https://spec.example.test/specs/a.json": {
          type: "object",
          properties: { a: { type: "string" }, child: { $ref: "b.json" } },
          required: ["a"],
          additionalProperties: false,
        },
        "https://spec.example.test/specs/b.json": {
          type: "object",
          properties: {
            b: { type: "integer", minimum: 1 },
            child: { $ref: "a.json" },
          },
          required: ["b"],
          additionalProperties: false,
        },
      };
      const program = bundleOpenApi(
        document(schema),
        SOURCE,
        loader(sources, requested),
        REMOTE,
      );
      const bundled = yield* program;
      expect(requested).toEqual(Object.keys(sources));
      const compiled = operation(bundled);
      expect(
        accepts(compiled, {
          body: { first: { a: "root", child: { b: 2, child: { a: "leaf" } } } },
        }),
      ).toBe(true);
      expect(
        accepts(compiled, { body: { first: { a: "root", child: { b: 0 } } } }),
      ).toBe(false);
      expect(Object.keys(definitions(bundled))).toHaveLength(2);
      expect(() =>
        Schema.toJsonSchemaDocument(compiled.parametersSchema),
      ).not.toThrow();
      expect(yield* program).toEqual(bundled);
      expect(requested).toEqual([
        ...Object.keys(sources),
        ...Object.keys(sources),
      ]);
    }),
);

it.effect(
  "resolves local descendant documents and external pointer chains",
  () =>
    Effect.gen(function* () {
      const source = new URL("file:///project/spec/openapi.yaml");
      const sources = {
        "file:///project/spec/shared/a.json": {
          schema: { $ref: "../b.json#/schemas/Value" },
        },
        "file:///project/spec/b.json": {
          schemas: { Value: { type: "integer", minimum: 2 } },
        },
      };
      const bundled = yield* bundle(
        document({ $ref: "shared/a.json#/schema" }),
        LOCAL,
        sources,
        source,
      );
      expect(accepts(operation(bundled), { body: 2 })).toBe(true);
      expect(accepts(operation(bundled), { body: 1 })).toBe(false);
    }),
);

it.effect.each(["3.0.3", "3.1.0", "3.2.1"])(
  "applies version-specific schema $ref sibling rules (%s)",
  (version) =>
    Effect.gen(function* () {
      const bundled = yield* bundle(
        document(
          { $ref: "#/components/schemas/Value", minLength: 4 },
          { schemas: { Value: { type: "string", minLength: 2 } } },
          version,
        ),
      );
      const compiled = operation(bundled);
      expect(accepts(compiled, { body: "good" })).toBe(true);
      expect(accepts(compiled, { body: "ok" })).toBe(
        version.startsWith("3.0."),
      );
    }),
);

it.effect.each(["3.0.3", "3.1.0", "3.2.1"])(
  "expands parameter and request body refs without accepting invalid Reference Object siblings (%s)",
  (version) =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: version,
        servers: [{ url: "https://api.example.test" }],
        paths: {
          "/items": {
            post: {
              parameters: [
                {
                  $ref: "#/components/parameters/Search",
                  required: true,
                  description: "override",
                },
              ],
              requestBody: {
                $ref: "#/components/requestBodies/Body",
                required: false,
              },
              responses: { "200": { $ref: "#/components/responses/Okay" } },
            },
          },
        },
        components: {
          parameters: {
            Search: {
              name: "q",
              in: "query",
              required: false,
              description: "original",
              schema: { type: "string" },
            },
          },
          requestBodies: {
            Body: {
              required: true,
              content: {
                "application/json": { $ref: "#/components/mediaTypes/Request" },
              },
            },
          },
          mediaTypes: {
            Request: { schema: { type: "integer", minimum: 2 } },
            Response: {},
          },
          responses: {
            Okay: {
              content: {
                "application/json": {
                  $ref: "#/components/mediaTypes/Response",
                },
              },
            },
          },
          schemas: {},
          securitySchemes: {},
        },
      };
      // 3.0/3.1 don't standardize media-type Reference Objects; the compiler's existing extension supports them.
      const bundled = yield* bundle(entry);
      const compiled = operation(bundled);
      expect(accepts(compiled, { body: 2 })).toBe(true);
      expect(accepts(compiled, {})).toBe(false);
      expect(accepts(compiled, { body: 1 })).toBe(false);
      expect(JSON.stringify(bundled)).toContain(
        version.startsWith("3.0.")
          ? '"description":"original"'
          : '"description":"override"',
      );
    }),
);

it.effect("expands deep Path Item and vendor operation references", () =>
  Effect.gen(function* () {
    const entry: JsonValue = {
      openapi: "3.0.3",
      servers: [{ url: "https://api.example.test" }],
      paths: { "/items": { $ref: "#/x-paths/0", description: "local path" } },
      "x-paths": [{ get: { $ref: "#/x-operations/get" } }],
      "x-operations": {
        get: { operationId: "list_items", responses: RESPONSES },
      },
    };
    expect(compileOpenApi(yield* bundle(entry)).operations[0]?.name).toBe(
      "list_items",
    );
  }),
);

it.effect(
  "rejects Path Item sibling collisions rather than guessing merge semantics",
  () =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        paths: {
          "/items": {
            $ref: "#/components/pathItems/Items",
            get: { responses: RESPONSES },
          },
        },
        components: { pathItems: { Items: { get: { responses: RESPONSES } } } },
      };
      expect(yield* Effect.flip(bundle(entry))).toHaveProperty(
        "reason",
        "collision",
      );
    }),
);

it.effect(
  "keeps examples, defaults, extensions, response schemas and unused components opaque",
  () =>
    Effect.gen(function* () {
      const opaque = {
        $ref: "https://secret@different.test/private?token=secret",
      };
      const entry = document(
        {
          type: "object",
          properties: {
            name: {
              type: "string",
              default: opaque,
              examples: [opaque],
              "x-extra": opaque,
            },
          },
          additionalProperties: false,
        },
        { schemas: { Unused: opaque }, requestBodies: { Unused: opaque } },
      );
      entry["x-extra"] = opaque;
      const paths = entry.paths;
      if (paths === null || typeof paths !== "object" || Array.isArray(paths))
        throw new Error("Missing paths.");
      paths["/status"] = {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": { schema: opaque },
                "text/plain": opaque,
              },
            },
            "400": opaque,
          },
        },
      };
      const bundled = yield* bundle(entry, REMOTE);
      expect(bundled).toEqual(entry);
      expect(compileOpenApi(bundled).operations).toHaveLength(2);
    }),
);

it.effect("does not fetch unselected request representations", () =>
  Effect.gen(function* () {
    const entry: JsonValue = {
      openapi: "3.2.1",
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/items": {
          post: {
            requestBody: {
              content: {
                "application/json": { schema: { type: "string" } },
                "application/x-www-form-urlencoded": {
                  $ref: "https://other.test/unneeded",
                },
                "multipart/form-data": { $ref: "https://other.test/unneeded" },
              },
            },
            responses: RESPONSES,
          },
        },
      },
    };
    expect(
      compileOpenApi(yield* bundle(entry, REMOTE)).operations,
    ).toHaveLength(1);
  }),
);

it.effect.each([
  { method: "head", status: "200" },
  { method: "get", status: "204" },
  { method: "get", status: "205" },
] as const)(
  "resolves response metadata while keeping content-free media opaque (%j)",
  ({ method, status }) =>
    Effect.gen(function* () {
      const unused = {
        $ref: "https://secret@disallowed.test/private?token=secret",
      };
      const content = { "application/json": unused, "text/plain": unused };
      const entry: JsonValue = {
        openapi: "3.2.1",
        servers: [{ url: "https://api.example.test" }],
        paths: { "/empty": { [method]: { $ref: "operations.json#/Empty" } } },
      };
      const sources = {
        "https://spec.example.test/specs/operations.json": {
          Empty: {
            operationId: "empty",
            responses: {
              [status]: {
                $ref: "responses.json#/Empty",
                description: "local description",
                summary: "local summary",
              },
            },
          },
        },
        "https://spec.example.test/specs/responses.json": {
          Empty: { description: "original", summary: "original", content },
        },
      };
      const requested: string[] = [];
      const bundled = yield* bundleOpenApi(
        entry,
        SOURCE,
        loader(sources, requested),
        { ...REMOTE, maxDocuments: 3 },
      );
      expect(requested).toEqual(Object.keys(sources));
      expect(bundled).toMatchObject({
        paths: {
          "/empty": {
            [method]: {
              responses: {
                [status]: {
                  description: "local description",
                  summary: "local summary",
                  content,
                },
              },
            },
          },
        },
      });
      const compiled = operation(bundled);
      expect(compiled.responses).toEqual({ [status]: "empty" });
      expect(compiled.responseContentTypes).toEqual([]);
    }),
);

it.effect.each(["get", "head"])(
  "keeps unused response header references opaque (%s)",
  (method) =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        servers: [{ url: "https://api.example.test" }],
        paths: {
          "/status": {
            [method]: {
              responses: {
                "200": {
                  content: { "application/json": {} },
                  headers: {
                    "X-Unused": {
                      $ref: "https://secret@disallowed.test/private?token=secret",
                    },
                  },
                },
              },
            },
          },
        },
      };
      const requested: string[] = [];
      const bundled = yield* bundleOpenApi(
        entry,
        SOURCE,
        loader({}, requested),
        { ...REMOTE, maxDocuments: 1 },
      );
      expect(requested).toEqual([]);
      expect(bundled).toEqual(entry);
      expect(operation(bundled).responses).toEqual({
        "200": method === "head" ? "empty" : "json",
      });
    }),
);

it.effect.each([
  { contentType: "application/json", mode: "json" },
  { contentType: "text/plain", mode: "text" },
  { contentType: "application/x-www-form-urlencoded", mode: "form" },
] as const)(
  "does not fetch encoding header references outside multipart (%j)",
  ({ contentType, mode }) =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        servers: [{ url: "https://api.example.test" }],
        paths: {
          "/items": {
            post: {
              requestBody: {
                content: {
                  [contentType]: {
                    schema:
                      mode === "text"
                        ? { type: "string" }
                        : {
                            type: "object",
                            properties: { message: { type: "string" } },
                          },
                    encoding: {
                      message: {
                        headers: {
                          "X-Unused": {
                            $ref: "https://secret@disallowed.test/private?token=secret",
                          },
                        },
                      },
                    },
                  },
                },
              },
              responses: RESPONSES,
            },
          },
        },
      };
      const requested: string[] = [];
      const bundled = yield* bundleOpenApi(
        entry,
        SOURCE,
        loader({}, requested),
        { ...REMOTE, maxDocuments: 1 },
      );
      expect(requested).toEqual([]);
      expect(bundled).toEqual(entry);
      const compiled = operation(bundled);
      expect(compiled.body?.mode).toBe(mode);
      expect(
        accepts(compiled, {
          body: mode === "text" ? "ok" : { message: "ok" },
        }),
      ).toBe(true);
    }),
);

it.effect(
  "leaves external references untouched when external loading is disabled",
  () =>
    Effect.gen(function* () {
      const entry = document({ $ref: "https://different.test/schema" });
      expect(yield* bundle(entry)).toEqual(entry);
    }),
);

it.effect(
  "uses $self for descriptive references and retrieval URI for API servers",
  () =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        $self: "https://spec.example.test/canonical/root.json",
        servers: [
          { url: "./{version}", variables: { version: { default: "v2" } } },
        ],
        paths: { "/items": { get: { $ref: "shared/operation.json" } } },
      };
      const requested: string[] = [];
      const sources = {
        "https://spec.example.test/canonical/shared/operation.json": {
          operationId: "list_items",
          servers: [
            { url: "../{version}", variables: { version: { default: "v3" } } },
          ],
          responses: RESPONSES,
        },
      };
      const bundled = yield* bundleOpenApi(
        entry,
        SOURCE,
        loader(sources, requested),
        REMOTE,
      );
      expect(requested).toEqual(Object.keys(sources));
      expect(operation(bundled).baseUrl.href).toBe(
        "https://spec.example.test/canonical/v3/",
      );
      expect(JSON.stringify(bundled)).toContain(
        "https://spec.example.test/specs/v2",
      );
    }),
);

it.effect(
  "recognizes $self aliases without fetching the same document again",
  () =>
    Effect.gen(function* () {
      const entry = document(
        {
          $ref: "https://descriptions.test/canonical#/components/schemas/Value",
        },
        { schemas: { Value: { type: "string" } } },
        "3.2.1",
      );
      entry.$self = "https://descriptions.test/canonical";
      expect(
        accepts(operation(yield* bundle(entry, REMOTE)), { body: "yes" }),
      ).toBe(true);
    }),
);

it.effect(
  "keeps file-relative servers relative for an explicit API base URL",
  () =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        paths: { "/items": { get: { $ref: "operation.json" } } },
      };
      const bundled = yield* bundle(
        entry,
        LOCAL,
        {
          "file:///specs/operation.json": {
            servers: [{ url: "../api" }],
            responses: RESPONSES,
          },
        },
        new URL("file:///specs/root.json"),
      );
      expect(JSON.stringify(bundled)).toContain('"url":"../api"');
      expect(JSON.stringify(bundled)).not.toContain("file:");
      expect(
        compileOpenApi(bundled, {
          baseUrl: new URL("https://api.example.test/"),
        }).operations,
      ).toHaveLength(1);
    }),
);

it.effect.each([
  ["#/components/schemas/Missing", "missing"],
  ["#/components/schemas/A~2B", "pointer"],
  ["#/components/schemas/A%ZZ", "pointer"],
  ["#/components/schemas/A%FF", "pointer"],
  ["#Value", "scope"],
  ["#/x-array/-", "pointer"],
  ["#/x-array/01", "pointer"],
  ["#/x-array/-1", "pointer"],
  ["#/x-array/9007199254740993", "pointer"],
  ["#/x-array/2", "pointer"],
  ["#/components/schemas/toString", "missing"],
  ["#/components/schemas/constructor", "missing"],
] as const)(
  "reports malformed/missing pointers safely (%s)",
  ([reference, reason]) =>
    Effect.gen(function* () {
      const entry = document({ $ref: reference }, { schemas: {} });
      entry["x-array"] = [true];
      const error = yield* Effect.flip(bundle(entry));
      expect(error).toBeInstanceOf(ReferenceError);
      expect(error).toHaveProperty("reason", reason);
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain(reference);
    }),
);

it.effect.each([
  ["https://other.test/schema", REMOTE, SOURCE],
  ["http://spec.example.test/schema", REMOTE, SOURCE],
  ["https://secret@spec.example.test/schema", REMOTE, SOURCE],
  ["https://spec.example.test/schema?token=secret", REMOTE, SOURCE],
  [
    "file:///project/private.json",
    LOCAL,
    new URL("file:///project/spec/openapi.json"),
  ],
  ["../secret.json", LOCAL, new URL("file:///project/spec/openapi.json")],
  ["%2e%2e/secret.json", LOCAL, new URL("file:///project/spec/openapi.json")],
  [
    "https://spec.example.test/schema",
    LOCAL,
    new URL("file:///project/spec/openapi.json"),
  ],
  ["file:///project/spec/schema.json", REMOTE, SOURCE],
] as const)(
  "blocks disallowed external sources before dispatch (%s)",
  ([reference, options, source]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        bundle(document({ $ref: reference }), options, {}, source),
      );
      expect(error).toHaveProperty("reason", "policy");
      expect(JSON.stringify(error)).not.toContain("secret");
    }),
);

it.effect("permits loopback same-origin references", () =>
  Effect.gen(function* () {
    const bundled = yield* bundle(
      document({ $ref: "schema.json" }),
      REMOTE,
      { "http://127.0.0.1:4000/schema.json": { type: "boolean" } },
      new URL("http://127.0.0.1:4000/openapi.json"),
    );
    expect(accepts(operation(bundled), { body: false })).toBe(true);
  }),
);

it.effect.each([
  "$id",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
])("rejects unsupported schema scope features explicitly (%s)", (keyword) =>
  Effect.gen(function* () {
    expect(
      yield* Effect.flip(
        bundle(document({ type: "string", [keyword]: "secret" })),
      ),
    ).toHaveProperty("reason", "scope");
    const entry = document(
      { $ref: "#/components/schemas/Parent/properties/name" },
      {
        schemas: {
          Parent: {
            [keyword]: "secret",
            properties: { name: { type: "string" } },
          },
        },
      },
    );
    expect(yield* Effect.flip(bundle(entry))).toHaveProperty("reason", "scope");
  }),
);

it.effect(
  "ignores unsupported scope keywords in 3.0 Reference Object siblings",
  () =>
    Effect.gen(function* () {
      const entry = document(
        { $ref: "#/components/schemas/Value", $id: "secret" },
        { schemas: { Value: { type: "string" } } },
        "3.0.3",
      );
      expect(accepts(operation(yield* bundle(entry)), { body: "ok" })).toBe(
        true,
      );
    }),
);

it.effect("enforces distinct-document and dereference-depth limits", () =>
  Effect.gen(function* () {
    const entry = document({ $ref: "a.json" });
    const sources = {
      "https://spec.example.test/specs/a.json": { $ref: "b.json" },
      "https://spec.example.test/specs/b.json": { type: "string" },
    };
    expect(
      yield* Effect.flip(
        bundle(entry, { ...REMOTE, maxDocuments: 2 }, sources),
      ),
    ).toHaveProperty("reason", "documents");
    expect(
      yield* Effect.flip(bundle(entry, { ...REMOTE, maxDepth: 1 }, sources)),
    ).toHaveProperty("reason", "depth");
    expect(
      accepts(
        operation(
          yield* bundle(
            entry,
            { ...REMOTE, maxDepth: 2, maxDocuments: 3 },
            sources,
          ),
        ),
        { body: "ok" },
      ),
    ).toBe(true);
  }),
);

it.effect.each([
  { ...NONE, maxDepth: 0 },
  { ...NONE, maxDepth: 1.5 },
  { ...NONE, maxDocuments: 0 },
  { ...NONE, maxDocuments: Number.POSITIVE_INFINITY },
])("validates limits at the public boundary (%j)", (options) =>
  Effect.gen(function* () {
    expect(yield* Effect.flip(bundle(document(true), options))).toHaveProperty(
      "reason",
      "configuration",
    );
  }),
);

it.effect(
  "reports cyclic external API object references without leaking source URLs",
  () =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        paths: { "/items": { get: { $ref: "a.json" } } },
      };
      const sources = {
        "https://spec.example.test/specs/a.json": { $ref: "b.json" },
        "https://spec.example.test/specs/b.json": { $ref: "a.json" },
      };
      const error = yield* Effect.flip(bundle(entry, REMOTE, sources));
      expect(error).toHaveProperty("reason", "cycle");
      expect(JSON.stringify(error)).not.toContain("example.test");
    }),
);

it.effect("preserves the injected loader's typed error channel", () =>
  Effect.gen(function* () {
    class LoaderError extends Data.TaggedError("LoaderError")<
      Readonly<{ message: string }>
    > {}
    const expected = new LoaderError({ message: "Document unavailable." });
    const error = yield* Effect.flip(
      bundleOpenApi(
        document({ $ref: "a.json" }),
        SOURCE,
        () => Effect.fail(expected),
        REMOTE,
      ),
    );
    expect(error).toBe(expected);
  }),
);

it.effect(
  "resolves reached external security schemes without changing credential names",
  () =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        servers: [{ url: "https://api.example.test" }],
        security: [{ Key: [] }],
        components: {
          securitySchemes: { Key: { $ref: "security.json#/Key" } },
        },
        paths: { "/items": { get: { responses: RESPONSES } } },
      };
      const bundled = yield* bundle(entry, REMOTE, {
        "https://spec.example.test/specs/security.json": {
          Key: { type: "apiKey", in: "header", name: "X-Key" },
        },
      });
      expect(
        compileOpenApi(bundled, {
          credentials: { Key: Redacted.make("secret") },
        }).operations[0]?.authentication[0]?.name,
      ).toBe("X-Key");
    }),
);

it.effect("rejects ambiguous document aliases", () =>
  Effect.gen(function* () {
    const entry = document(
      {
        type: "object",
        properties: {
          a: { $ref: "a.json#/components/schemas/Value" },
          b: { $ref: "b.json#/components/schemas/Value" },
        },
      },
      {},
      "3.2.1",
    );
    const sources = {
      "https://spec.example.test/specs/a.json": {
        openapi: "3.2.1",
        $self: "https://identity.test/schema",
        components: { schemas: { Value: { type: "string" } } },
      },
      "https://spec.example.test/specs/b.json": {
        openapi: "3.2.1",
        $self: "https://identity.test/schema",
        components: { schemas: { Value: { type: "string" } } },
      },
    };
    expect(yield* Effect.flip(bundle(entry, REMOTE, sources))).toHaveProperty(
      "reason",
      "collision",
    );
  }),
);

it.effect.each(["3.0.3", "3.1.0"])(
  "ignores the nonstandard $self keyword in older OpenAPI documents (%s)",
  (version) =>
    Effect.gen(function* () {
      const entry = document({ $ref: "schema.json" }, {}, version);
      entry.$self = "https://other.test/misleading/root.json";
      const bundled = yield* bundle(entry, REMOTE, {
        "https://spec.example.test/specs/schema.json": { type: "string" },
      });
      expect(accepts(operation(bundled), { body: "ok" })).toBe(true);
    }),
);

it.effect.each([
  "#%2Fcomponents%2Fschemas%2FValue",
  "openapi.yaml#/components/schemas/Value",
  "https://spec.example.test/specs/openapi.yaml#/components/schemas/Value",
])(
  "canonicalizes same-document URI references for native schema import (%s)",
  (reference) =>
    Effect.gen(function* () {
      const entry = document(
        { $ref: reference },
        { schemas: { Value: { type: "integer", minimum: 2 } } },
      );
      expect(accepts(operation(yield* bundle(entry)), { body: 2 })).toBe(true);
      expect(accepts(operation(yield* bundle(entry)), { body: 1 })).toBe(false);
    }),
);

it.effect.each(["3.0.3", "3.2.1"])(
  "rejects mixed OpenAPI minor versions before reinterpreting schemas (%s)",
  (version) =>
    Effect.gen(function* () {
      const entry = document({ $ref: "schema.json#/components/schemas/Value" });
      const error = yield* Effect.flip(
        bundle(entry, REMOTE, {
          "https://spec.example.test/specs/schema.json": {
            openapi: version,
            components: { schemas: { Value: { type: "string" } } },
          },
        }),
      );
      expect(error).toHaveProperty("reason", "version");
    }),
);

it.effect.each<JsonValue>([null, 1, "bad", [], { invalid: null }])(
  "rejects malformed embedded definition maps (%j)",
  (value) =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(bundle(document({ type: "string", $defs: value }))),
      ).toHaveProperty("reason", "target");
    }),
);

it.effect.each([false, true])(
  "bounds cached acyclic schema subtrees independently of traversal order (%s)",
  (reverse) =>
    Effect.gen(function* () {
      const properties: JsonObject = reverse
        ? {
            b: { $ref: "#/components/schemas/B" },
            a: { $ref: "#/components/schemas/A" },
          }
        : {
            a: { $ref: "#/components/schemas/A" },
            b: { $ref: "#/components/schemas/B" },
          };
      const entry = document(
        { type: "object", properties },
        {
          schemas: {
            A: { $ref: "#/components/schemas/Leaf" },
            B: { $ref: "#/components/schemas/A" },
            Leaf: { type: "string" },
          },
        },
      );
      expect(
        yield* Effect.flip(bundle(entry, { ...NONE, maxDepth: 2 })),
      ).toHaveProperty("reason", "depth");
      expect(
        compileOpenApi(yield* bundle(entry, { ...NONE, maxDepth: 3 }))
          .operations,
      ).toHaveLength(1);
    }),
);

it.effect(
  "retains an unsupported ancestor schema dialect when resolving a deep pointer",
  () =>
    Effect.gen(function* () {
      const entry = document({
        $ref: "external.json#/components/schemas/Wrapper/properties/value",
      });
      const sources = {
        "https://spec.example.test/specs/external.json": {
          openapi: "3.1.0",
          components: {
            schemas: {
              Wrapper: {
                $schema: "https://unsupported.test/dialect",
                type: "object",
                properties: { value: { type: "string", minLength: 2 } },
              },
            },
          },
        },
      };
      const bundled = yield* bundle(entry, REMOTE, sources);
      expect(() => compileOpenApi(bundled)).toThrow(
        "Unsupported JSON Schema dialect",
      );
    }),
);

it.effect(
  "uses the closest schema resource dialect instead of the document default",
  () =>
    Effect.gen(function* () {
      const entry = document({
        $ref: "external.json#/components/schemas/Wrapper/properties/value",
      });
      const sources = {
        "https://spec.example.test/specs/external.json": {
          openapi: "3.1.0",
          jsonSchemaDialect: "https://unsupported.test/dialect",
          components: {
            schemas: {
              Wrapper: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { value: { type: "string", minLength: 2 } },
              },
            },
          },
        },
      };
      const compiled = operation(yield* bundle(entry, REMOTE, sources));
      expect(accepts(compiled, { body: "ok" })).toBe(true);
      expect(accepts(compiled, { body: "x" })).toBe(false);
    }),
);

it.effect(
  "preserves a target's explicit dialect over the ancestor dialect",
  () =>
    Effect.gen(function* () {
      const entry = document({
        $ref: "external.json#/components/schemas/Wrapper/properties/value",
      });
      const sources = {
        "https://spec.example.test/specs/external.json": {
          openapi: "3.1.0",
          components: {
            schemas: {
              Wrapper: {
                $schema: "https://unsupported.test/dialect",
                type: "object",
                properties: {
                  value: {
                    $schema: "https://json-schema.org/draft/2020-12/schema",
                    type: "integer",
                    minimum: 2,
                  },
                },
              },
            },
          },
        },
      };
      const compiled = operation(yield* bundle(entry, REMOTE, sources));
      expect(accepts(compiled, { body: 2 })).toBe(true);
      expect(accepts(compiled, { body: 1 })).toBe(false);
    }),
);

it.effect.each([false, true])(
  "retains ancestor dialect validation for boolean schema targets (%s)",
  (value) =>
    Effect.gen(function* () {
      const entry = document({ $ref: "external.json#/$defs/Value" });
      const sources = {
        "https://spec.example.test/specs/external.json": {
          $schema: "https://unsupported.test/dialect",
          $defs: { Value: value },
        },
      };
      const bundled = yield* bundle(entry, REMOTE, sources);
      expect(JSON.stringify(definitions(bundled))).toContain(
        "https://unsupported.test/dialect",
      );
      expect(() => compileOpenApi(bundled)).toThrow(
        "Unsupported JSON Schema dialect",
      );
    }),
);

it.effect(
  "retains supported raw JSON Schema dialects for definitions, including boolean schemas",
  () =>
    Effect.gen(function* () {
      const sources = {
        "https://spec.example.test/specs/external.json": {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $defs: {
            Value: { type: "integer", minimum: 2 },
            Anything: true,
            Nothing: false,
          },
        },
      };
      const compiled = operation(
        yield* bundle(
          document({ $ref: "external.json#/$defs/Value" }),
          REMOTE,
          sources,
        ),
      );
      expect(accepts(compiled, { body: 2 })).toBe(true);
      expect(accepts(compiled, { body: 1 })).toBe(false);
      const anything = operation(
        yield* bundle(
          document({ $ref: "external.json#/$defs/Anything" }),
          REMOTE,
          sources,
        ),
      );
      expect(
        accepts(anything, { body: { arbitrary: [null, false, 42] } }),
      ).toBe(true);
      const nothing = operation(
        yield* bundle(
          document({ $ref: "external.json#/$defs/Nothing" }),
          REMOTE,
          sources,
        ),
      );
      expect(accepts(nothing, { body: null })).toBe(false);
    }),
);

it.effect.each([
  "https://user:secret@other.test/schema",
  "https://other.test/schema?token=secret",
])(
  "rejects secret-bearing URL forms even when external loading is disabled (%s)",
  (reference) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        bundle(document({ $ref: reference }), NONE),
      );
      expect(error).toHaveProperty("reason", "policy");
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("other.test");
    }),
);

it.effect(
  "preserves an external OpenAPI document's declared schema dialect",
  () =>
    Effect.gen(function* () {
      const entry = document({
        $ref: "external.json#/components/schemas/Value",
      });
      const bundled = yield* bundle(entry, REMOTE, {
        "https://spec.example.test/specs/external.json": {
          openapi: "3.1.1",
          jsonSchemaDialect: "https://unsupported.example.test/dialect",
          components: { schemas: { Value: { type: "string" } } },
        },
      });
      expect(JSON.stringify(definitions(bundled))).toContain(
        "https://unsupported.example.test/dialect",
      );
      expect(() => compileOpenApi(bundled)).toThrow(
        "Unsupported JSON Schema dialect",
      );
    }),
);

it.effect(
  "does not resolve path parameters or custom operations when no operation is callable after filtering",
  () =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        servers: [{ url: "https://api.example.test" }],
        paths: {
          "/items": {
            parameters: [{ $ref: "https://other.test/private" }],
            post: { tags: ["excluded"], responses: RESPONSES },
            additionalOperations: {
              COPY: { $ref: "https://other.test/private" },
            },
          },
        },
      };
      expect(yield* bundle(entry, { ...REMOTE, methods: ["get"] })).toEqual(
        entry,
      );
      expect(yield* bundle(entry, { ...REMOTE, tags: ["included"] })).toEqual(
        entry,
      );
    }),
);

it.effect.each([false, true])(
  "bounds shared cyclic schema subtrees without retaining the first traversal's ancestry (%s)",
  (reverse) =>
    Effect.gen(function* () {
      const properties: JsonObject = reverse
        ? {
            deep: { $ref: "#/components/schemas/B" },
            shallow: { $ref: "#/components/schemas/A" },
          }
        : {
            shallow: { $ref: "#/components/schemas/A" },
            deep: { $ref: "#/components/schemas/B" },
          };
      const entry = document(
        { type: "object", properties },
        {
          schemas: {
            A: {
              type: "object",
              properties: { self: { $ref: "#/components/schemas/A" } },
            },
            B: { $ref: "#/components/schemas/A" },
          },
        },
      );
      expect(
        yield* Effect.flip(bundle(entry, { ...NONE, maxDepth: 1 })),
      ).toHaveProperty("reason", "depth");
      expect(
        compileOpenApi(yield* bundle(entry, { ...NONE, maxDepth: 2 }))
          .operations,
      ).toHaveLength(1);
    }),
);

it.effect.each([false, true])(
  "bounds cached API object chains independently of traversal order (%s)",
  (reverse) =>
    Effect.gen(function* () {
      const paths: JsonObject = reverse
        ? {
            "/b": { get: { $ref: "#/x-operations/B" } },
            "/a": { get: { $ref: "#/x-operations/A" } },
          }
        : {
            "/a": { get: { $ref: "#/x-operations/A" } },
            "/b": { get: { $ref: "#/x-operations/B" } },
          };
      const entry: JsonValue = {
        openapi: "3.2.1",
        paths,
        "x-operations": {
          A: { responses: RESPONSES },
          B: { $ref: "#/x-operations/A" },
        },
      };
      expect(
        yield* Effect.flip(bundle(entry, { ...NONE, maxDepth: 1 })),
      ).toHaveProperty("reason", "depth");
    }),
);

it.effect(
  "does not resolve unused global security for selected anonymous operations",
  () =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        servers: [{ url: "https://api.example.test" }],
        security: [{ Key: [] }],
        components: {
          securitySchemes: { Key: { $ref: "https://other.test/private" } },
        },
        paths: { "/items": { get: { security: [], responses: RESPONSES } } },
      };
      expect(
        compileOpenApi(yield* bundle(entry, REMOTE)).operations,
      ).toHaveLength(1);
    }),
);

it.effect.each([false, true])(
  "compares resolved security schemes structurally with stable credential names (%s)",
  (rootReference) =>
    Effect.gen(function* () {
      const entry: JsonValue = {
        openapi: "3.2.1",
        servers: [{ url: "https://api.example.test" }],
        security: [{ Key: [] }],
        components: {
          securitySchemes: {
            Key: rootReference
              ? { $ref: "security.json#/Key" }
              : { name: "X-Key", in: "header", type: "apiKey" },
          },
        },
        paths: { "/items": { $ref: "operations.json#/item" } },
      };
      const sources = {
        "https://spec.example.test/specs/operations.json": {
          components: {
            securitySchemes: { Key: { $ref: "security.json#/Key" } },
          },
          item: { get: { security: [{ Key: [] }], responses: RESPONSES } },
        },
        "https://spec.example.test/specs/security.json": {
          Key: { type: "apiKey", in: "header", name: "X-Key" },
        },
      };
      const bundled = yield* bundle(entry, REMOTE, sources);
      expect(
        compileOpenApi(bundled, {
          credentials: { Key: Redacted.make("secret") },
        }).operations[0]?.authentication[0]?.scheme,
      ).toBe("Key");
    }),
);
