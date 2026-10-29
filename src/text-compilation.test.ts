import { dirname, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { describe, expect, it } from "@effect/vitest";
import { loadOperationCatalog } from "./catalog.ts";
import {
  isTextMediaType,
  textMediaEssence,
  selectRequestMediaType,
  selectResponseMediaTypes,
} from "./media-type.ts";
import { compileOpenApi } from "./openapi.ts";
import { API_RESPONSES, accepts, findOperation } from "./test-fixtures.ts";

const compile = (content: object, version = "3.1.2", schemas: object = {}) =>
  compileOpenApi({
    openapi: version,
    servers: [{ url: "https://api.example.com" }],
    components: { schemas },
    paths: {
      "/health": { get: { responses: API_RESPONSES } },
      "/text": {
        post: {
          operationId: "text",
          requestBody: { required: true, content },
          responses: API_RESPONSES,
        },
      },
    },
  });
const responses = (content: object) =>
  compileOpenApi({
    openapi: "3.2.1",
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/health": { get: {} },
      "/text": {
        get: { operationId: "text", responses: { "200": { content } } },
      },
    },
  });

describe("Ordinary UTF-8 text media contracts", () => {
  it.each([
    "text/plain",
    "Text/HTML; Charset=UTF-8",
    'text/csv; charset="utf8"',
    'text/plain; charset="UTF-8"; format="semi;colon"',
    "text/xml; custom=token",
    "text/markdown",
  ])("accepts a bounded ordinary text representation (%s)", (type) => {
    expect(isTextMediaType(type)).toBe(true);
    expect(textMediaEssence(type)).toBe(
      type.split(";", 1)[0]?.trim().toLowerCase(),
    );
  });
  it.each([
    "text/event-stream",
    "text/x-ndjson",
    "text/jsonl",
    "text/json-seq",
    "text/vnd.example+jsonl",
    "application/octet-stream",
    "multipart/form-data",
    "text/*",
    "text/plain; charset=iso-8859-1",
    "text/plain; charset=utf-16",
    'text/plain; charset=""',
    "text/plain; charset=utf-8; Charset=utf-8",
    "text/plain; broken",
    "text/plain;",
    'text/plain; charset="utf-8',
    "text/plain\r\nX-Secret: value",
    "text/plain\u0000",
    "text/plain\t",
  ])(
    "rejects unsafe, sequential or unsupported text representations (%s)",
    (type) => {
      expect(isTextMediaType(type)).toBe(false);
      expect(textMediaEssence(type)).toBeUndefined();
    },
  );
  it("shares deterministic request and response preference across media selection", () => {
    expect(
      selectRequestMediaType([
        "text/plain",
        "application/x-www-form-urlencoded",
        "application/json",
      ]),
    ).toBe("application/json");
    expect(
      selectRequestMediaType([
        "text/plain",
        "application/x-www-form-urlencoded",
      ]),
    ).toBe("application/x-www-form-urlencoded");
    expect(
      selectResponseMediaTypes([
        "text/plain",
        "application/json",
        "application/problem+json",
      ]),
    ).toEqual(["application/json", "application/problem+json"]);
    expect(
      selectResponseMediaTypes([
        "text/plain",
        "text/html",
        "text/event-stream",
      ]),
    ).toEqual(["text/plain", "text/html"]);
  });
  it.each(["3.0.4", "3.1.2", "3.2.1"])(
    "imports native text string references and retains constraints (%s)",
    (version) => {
      const catalog = compile(
        {
          "text/plain; charset=utf-8": {
            schema: { $ref: "#/components/schemas/Text" },
          },
        },
        version,
        {
          Text: {
            type: "string",
            minLength: 3,
            maxLength: 8,
            pattern: "^[a-z]+$",
          },
        },
      );
      const operation = findOperation(catalog, "text");
      expect(operation.body).toEqual({
        mode: "text",
        contentType: "text/plain; charset=utf-8",
      });
      expect(accepts(operation, { body: "message" })).toBe(true);
      for (const body of [
        "",
        "hi",
        "MESSAGE",
        "toolongmessage",
        null,
        42,
        {},
        [],
      ])
        expect(accepts(operation, { body })).toBe(false);
    },
  );
  it.each([
    { anyOf: [{ type: "string", minLength: 1 }, { const: "" }] },
    { enum: ["first", "second"] },
    { allOf: [{ type: "string" }, { maxLength: 10 }] },
  ])(
    "proves string-only domains from the imported native AST (%s)",
    (schema) => {
      expect(compile({ "text/plain": { schema } }).unsupported).toEqual([]);
    },
  );
  it.each([
    true,
    false,
    {},
    { type: "integer" },
    { type: "array", items: { type: "string" } },
    { type: ["string", "null"] },
    { anyOf: [{ type: "string" }, { type: "boolean" }] },
    { type: "string", format: "binary" },
    { type: "string", format: "byte" },
    { type: "string", contentEncoding: "base64" },
  ])("diagnoses a text body not provably a nonbinary string (%s)", (schema) => {
    expect(
      compile({ "text/plain": { schema } }).unsupported[0]?.reason,
    ).toContain("string schema");
  });
  it("diagnoses binary annotations through native referenced schema metadata", () => {
    expect(
      compile(
        { "text/plain": { schema: { $ref: "#/components/schemas/Binary" } } },
        "3.1.2",
        { Binary: { type: "string", format: "binary" } },
      ).unsupported[0]?.reason,
    ).toContain("nonbinary");
  });
  it.each([
    {
      allOf: [
        { type: "string", format: "binary" },
        { type: "string", format: "email" },
      ],
    },
    { allOf: [{ type: "string" }, { minLength: 1, format: "binary" }] },
    { allOf: [{ type: "string" }, { minLength: 1, format: "byte" }] },
    {
      allOf: [{ type: "string" }, { minLength: 1, contentEncoding: "base64" }],
    },
  ])(
    "retains reached binary annotations before native AST lowering (%s)",
    (schema) => {
      expect(
        compile({ "text/plain": { schema } }).unsupported[0]?.reason,
      ).toContain("nonbinary");
    },
  );
  it("follows binary annotations in referenced composition without scanning examples or unrelated definitions", () => {
    const schemas = {
      Encoded: {
        allOf: [{ type: "string" }, { minLength: 1, format: "binary" }],
      },
      Plain: {
        type: "string",
        examples: [{ format: "binary", contentEncoding: "base64" }],
      },
    };
    expect(
      compile(
        { "text/plain": { schema: { $ref: "#/components/schemas/Encoded" } } },
        "3.1.2",
        schemas,
      ).unsupported[0]?.reason,
    ).toContain("nonbinary");
    expect(
      compile(
        { "text/plain": { schema: { $ref: "#/components/schemas/Plain" } } },
        "3.1.2",
        schemas,
      ).unsupported,
    ).toEqual([]);
  });
  it("honors ignored OpenAPI 3.0 reference siblings in binary annotation checks", () => {
    const schema = {
      $ref: "#/components/schemas/Plain",
      format: "binary",
      allOf: [{ type: "string", contentEncoding: "base64" }],
    };
    const schemas = { Plain: { type: "string" } };
    expect(
      compile({ "text/plain": { schema } }, "3.0.4", schemas).unsupported,
    ).toEqual([]);
    expect(
      compile({ "text/plain": { schema } }, "3.1.2", schemas).unsupported[0]
        ?.reason,
    ).toContain("nonbinary");
  });
  it("uses an explicit native string when text media omits a schema", () => {
    const operation = findOperation(compile({ "text/plain": {} }), "text");
    expect(accepts(operation, { body: "" })).toBe(true);
    expect(accepts(operation, { body: null })).toBe(false);
    expect(accepts(operation, { body: {} })).toBe(false);
    expect(accepts(operation, {})).toBe(false);
  });
  it("keeps JSON preferred for request and response media and leaves text metadata absent", () => {
    const operation = findOperation(
      compile({
        "text/plain": { schema: { type: "number" } },
        "application/json": { schema: true },
      }),
      "text",
    );
    expect(operation.body?.mode).toBe("json");
    expect(accepts(operation, { body: 42 })).toBe(true);
    const selected = findOperation(
      responses({ "text/plain": { itemSchema: true }, "application/json": {} }),
      "text",
    );
    expect(selected.responses).toEqual({ "200": "json" });
    expect(selected.responseContentTypes).toEqual(["application/json"]);
    expect(selected).not.toHaveProperty("responseTextContentTypes");
  });
  it("records selected text media per status while retaining empty and JSON responses", () => {
    const operation = findOperation(
      compileOpenApi({
        openapi: "3.2.1",
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/text": {
            get: {
              operationId: "text",
              responses: {
                "200": {
                  content: { "text/plain": {}, "text/csv; charset=utf-8": {} },
                },
                "201": { content: { "text/html": {} } },
                "204": {},
                "2XX": {
                  content: { "application/json": {}, "text/plain": {} },
                },
              },
            },
          },
        },
      }),
      "text",
    );
    expect(operation.responses).toEqual({
      "200": "text",
      "201": "text",
      "204": "empty",
      "2XX": "json",
    });
    expect(operation.responseTextContentTypes).toEqual({
      "200": ["text/plain", "text/csv; charset=utf-8"],
      "201": ["text/html"],
    });
    expect(operation.responseContentTypes).toEqual([
      "text/plain",
      "text/csv; charset=utf-8",
      "text/html",
      "application/json",
    ]);
  });
  it("diagnoses selected sequential text representations before exposing them", () => {
    expect(
      compile({
        "text/plain": {
          schema: { type: "string" },
          itemSchema: { type: "string" },
        },
      }).unsupported[0]?.reason,
    ).toContain("Sequential request");
    expect(
      responses({ "text/plain": { itemSchema: { type: "string" } } })
        .unsupported[0]?.reason,
    ).toContain("Sequential response");
    expect(
      responses({ "text/event-stream": {} }).unsupported[0]?.reason,
    ).toContain("Unsupported response");
  });
});

it.layer(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer))(
  "Selected text reference loading",
  (it) => {
    const sourceFile = Effect.fnUntraced(function* (value: object) {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "text-media-",
      });
      const file = join(directory, "root.json");
      yield* fs.writeFileString(file, JSON.stringify(value));
      return file;
    });
    it.effect(
      "resolves selected text media and string constraints through the bounded external graph",
      () =>
        Effect.gen(function* () {
          const root = {
            openapi: "3.1.2",
            servers: [{ url: "https://api.example.com" }],
            paths: {
              "/text": {
                post: {
                  requestBody: {
                    required: true,
                    content: { "text/plain": { $ref: "./media.json#/Text" } },
                  },
                  responses: API_RESPONSES,
                },
              },
            },
          };
          const file = yield* sourceFile(root);
          const fs = yield* FileSystem.FileSystem;
          const media = JSON.stringify({
            Text: { schema: { $ref: "./types.json#/$defs/Message" } },
          });
          const types = JSON.stringify({
            $defs: { Message: { type: "string", minLength: 3 } },
          });
          yield* fs.writeFileString(join(dirname(file), "media.json"), media);
          yield* fs.writeFileString(join(dirname(file), "types.json"), types);
          const maxSpecBytes =
            Buffer.byteLength(JSON.stringify(root)) +
            Buffer.byteLength(media) +
            Buffer.byteLength(types);
          const catalog = yield* loadOperationCatalog(file, {
            referencesMode: "local",
            maxSpecBytes,
          });
          const operation = findOperation(catalog, "post_text");
          expect(operation.body?.mode).toBe("text");
          expect(accepts(operation, { body: "message" })).toBe(true);
          expect(accepts(operation, { body: "x" })).toBe(false);
          expect(
            yield* Effect.flip(
              loadOperationCatalog(file, {
                referencesMode: "local",
                maxSpecBytes: maxSpecBytes - 1,
              }),
            ),
          ).toHaveProperty("reason", "size");
        }),
    );
    it.effect("keeps unselected text media refs opaque when JSON exists", () =>
      Effect.gen(function* () {
        const content = {
          "application/json": {},
          "text/plain": {
            $ref: "https://disallowed.example.com/private-text.json",
          },
        };
        const file = yield* sourceFile({
          openapi: "3.1.2",
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/json": {
              post: {
                requestBody: { content },
                responses: { "200": { content } },
              },
            },
          },
        });
        const http = HttpClient.make(() =>
          Effect.die("Unselected media must not load."),
        );
        const catalog = yield* loadOperationCatalog(file, {
          referencesMode: "local",
          maxReferenceDocuments: 1,
        }).pipe(Effect.provideService(HttpClient.HttpClient, http));
        expect(catalog.operations[0]?.body?.mode).toBe("json");
        expect(catalog.operations[0]?.responses).toEqual({ "200": "json" });
      }),
    );
    it.effect(
      "resolves response media references while leaving response schema dependencies opaque",
      () =>
        Effect.gen(function* () {
          const file = yield* sourceFile({
            openapi: "3.1.2",
            servers: [{ url: "https://api.example.com" }],
            paths: {
              "/text": {
                get: {
                  responses: {
                    "200": {
                      content: { "text/plain": { $ref: "./media.json#/Text" } },
                    },
                  },
                },
              },
            },
          });
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            join(dirname(file), "media.json"),
            JSON.stringify({
              Text: {
                schema: {
                  $ref: "https://disallowed.example.com/private-schema.json",
                },
              },
            }),
          );
          const http = HttpClient.make(() =>
            Effect.die("Response schema must not load."),
          );
          const catalog = yield* loadOperationCatalog(file, {
            referencesMode: "local",
            maxReferenceDocuments: 2,
          }).pipe(Effect.provideService(HttpClient.HttpClient, http));
          expect(catalog.operations[0]?.responses).toEqual({ "200": "text" });
          expect(catalog.operations[0]?.responseTextContentTypes).toEqual({
            "200": ["text/plain"],
          });
        }),
    );
  },
);
