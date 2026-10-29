import { describe, expect, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { CORPUS, readFixture } from "../scripts/corpus.ts";
import { InvalidArguments } from "./api-errors.ts";
import { makeApiClient } from "./api-client.ts";
import { parseOpenApi } from "./catalog.ts";
import { encodeMultipartBody } from "./multipart.ts";
import { compileOpenApi } from "./openapi.ts";
import {
  OPENAPI_SCHEMA,
  type JsonObject,
  type JsonValue,
} from "./openapi-types.ts";
import { type ParameterProfile } from "./parameter-profile.ts";
import { accepts, API_RESPONSES, findOperation } from "./test-fixtures.ts";

const file = {
  dataBase64: "AAH/gA==",
  filename: "proof.pdf",
  mediaType: "application/pdf",
};
const bodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "purpose"],
  properties: {
    file: { type: "string", format: "binary" },
    purpose: { type: "string", enum: ["evidence"] },
    labels: { type: "array", items: { type: "string" } },
    details: {
      type: "object",
      additionalProperties: false,
      properties: { count: { type: "integer", minimum: 1 } },
    },
  },
};
const compile = (
  schema: unknown = bodySchema,
  encoding: unknown = {},
  parameterProfile: ParameterProfile = "spec",
  components: object = {},
) =>
  compileOpenApi(
    {
      openapi: "3.1.2",
      components,
      servers: [{ url: "https://upload.example.com" }],
      paths: {
        "/health": { get: { responses: API_RESPONSES } },
        "/files": {
          post: {
            operationId: "upload",
            requestBody: {
              required: true,
              content: { "multipart/form-data": { schema, encoding } },
            },
            responses: API_RESPONSES,
          },
        },
      },
    },
    { parameterProfile },
  );
const descriptor = (catalog = compile()) => {
  const operation = findOperation(catalog, "upload");
  if (operation.body?.mode !== "multipart")
    throw new Error("Expected multipart body");
  return operation.body.multipart;
};
const readParts = (bytes: Uint8Array, contentType: string) =>
  Effect.tryPromise(() =>
    new Response(Buffer.from(bytes), {
      headers: { "Content-Type": contentType },
    }).formData(),
  ).pipe(Effect.orDie);

describe("Bounded multipart uploads", () => {
  it("exposes file envelopes and retains ordinary body constraints", () => {
    const operation = findOperation(compile(), "upload");
    expect(
      accepts(operation, {
        body: { file, purpose: "evidence", details: { count: 1 } },
      }),
    ).toBe(true);
    for (const body of [
      { file: "/tmp/proof.pdf", purpose: "evidence" },
      {
        file: { ...file, url: "https://example.com/file" },
        purpose: "evidence",
      },
      { file, purpose: "other" },
      { file, purpose: "evidence", details: { count: 0 } },
      { purpose: "evidence" },
    ])
      expect(accepts(operation, { body })).toBe(false);
  });
  it.effect(
    "sends exact file bytes, repeated text and correctly typed JSON parts",
    () =>
      Effect.gen(function* () {
        const operation = findOperation(compile(), "upload");
        const body = {
          file,
          purpose: "evidence",
          labels: ["A + B&=é", "comma,value"],
          details: { count: 2 },
        };
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            expect(request.method).toBe("POST");
            expect(request.url).toBe("https://upload.example.com/files");
            if (request.body._tag !== "Uint8Array")
              throw new Error("Expected multipart bytes");
            const contentType = request.headers["content-type"];
            if (contentType === undefined)
              throw new Error("Missing content type");
            expect(contentType).toMatch(
              /^multipart\/form-data; boundary=openapi-mcp-[a-f0-9]{48}$/,
            );
            const parts = yield* readParts(request.body.body, contentType);
            const uploaded = parts.get("file");
            if (!(uploaded instanceof File))
              throw new Error("Expected file part");
            expect(uploaded.name).toBe(file.filename);
            expect(uploaded.type).toBe(file.mediaType);
            expect(
              Buffer.from(
                yield* Effect.tryPromise(() => uploaded.arrayBuffer()).pipe(
                  Effect.orDie,
                ),
              ),
            ).toEqual(Buffer.from([0, 1, 255, 128]));
            expect(parts.get("purpose")).toBe("evidence");
            expect(parts.getAll("labels")).toEqual(body.labels);
            expect(parts.get("details")).toBe('{"count":2}');
            expect(Buffer.from(request.body.body).toString()).toContain(
              'name="details"\r\nContent-Type: application/json\r\n',
            );
            return HttpClientResponse.fromWeb(
              request,
              new Response("{}", {
                headers: { "Content-Type": "application/json" },
              }),
            );
          }),
        );
        expect(yield* makeApiClient(http).execute(operation, { body })).toEqual(
          {},
        );
      }),
  );
  it.effect("reuses the explicit bracket convention for multipart fields", () =>
    Effect.gen(function* () {
      const schema = {
        ...bodySchema,
        properties: {
          ...bodySchema.properties,
          nested: {
            type: "object",
            properties: {
              rows: {
                type: "array",
                items: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
              },
            },
          },
        },
      };
      const encoding = { nested: { style: "deepObject", explode: true } };
      expect(compile(schema, encoding).unsupported).toHaveLength(1);
      const encoded = encodeMultipartBody(
        { file, purpose: "evidence", nested: { rows: [{ value: "A + B&é" }] } },
        descriptor(compile(schema, encoding, "brackets-indexed")),
        10000,
      );
      const parts = yield* readParts(encoded.bytes, encoded.contentType);
      expect(parts.get("nested[rows][0][value]")).toBe("A + B&é");
    }),
  );
  it("counts the entire multipart body including boundaries and headers", () => {
    const body = { file, purpose: "evidence" };
    const multipart = descriptor();
    const size = encodeMultipartBody(body, multipart, 10000).bytes.length;
    expect(encodeMultipartBody(body, multipart, size).bytes).toHaveLength(size);
    expect(() => encodeMultipartBody(body, multipart, size - 1)).toThrow(
      /byte limit/,
    );
    expect(() =>
      encodeMultipartBody(
        { ...body, file: { ...file, dataBase64: "A".repeat(4096) } },
        multipart,
        100,
      ),
    ).toThrow(/bounded canonical base64/);
  });
  it.effect(
    "bounds text traversal before constructing multipart parts or making a request",
    () =>
      Effect.gen(function* () {
        let sent = false;
        const http = HttpClient.make((request) => {
          sent = true;
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("{}")),
          );
        });
        const body = {
          file,
          purpose: "evidence",
          labels: Array.from({ length: 4097 }, () => ""),
        };
        const failure = yield* Effect.flip(
          makeApiClient(http).execute(findOperation(compile(), "upload"), {
            body,
          }),
        );
        expect(failure).toBeInstanceOf(InvalidArguments);
        expect(failure.message).toContain("traversal limit");
        expect(sent).toBe(false);
      }),
  );
  it.effect.each([
    { ...file, dataBase64: "AB==" },
    { ...file, dataBase64: "AAH/gA" },
    { ...file, dataBase64: "AAH_gA==" },
    { ...file, dataBase64: "AAH/gA==\n" },
    { ...file, filename: "../proof.pdf" },
    { ...file, filename: "proof.pdf\n" },
    { ...file, filename: 'proof"\r\nX-Header: bad' },
    { ...file, mediaType: "application/pdf\r\nX-Header: bad" },
    { ...file, mediaType: "application/*" },
    { ...file, mediaType: "application/pdf\n" },
    { ...file, path: "/tmp/file" },
  ])("rejects invalid files before executing HTTP (%j)", (invalidFile) =>
    Effect.gen(function* () {
      let sent = false;
      const http = HttpClient.make((request) => {
        sent = true;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("{}")),
        );
      });
      expect(
        yield* Effect.flip(
          makeApiClient(http).execute(findOperation(compile(), "upload"), {
            body: { file: invalidFile, purpose: "evidence" },
          }),
        ),
      ).toBeInstanceOf(InvalidArguments);
      expect(sent).toBe(false);
    }),
  );
  it("enforces declared file media types", () => {
    const multipart = descriptor(
      compile(bodySchema, { file: { contentType: "application/pdf" } }),
    );
    expect(() =>
      encodeMultipartBody(
        { file: { ...file, mediaType: "image/png" }, purpose: "evidence" },
        multipart,
        10000,
      ),
    ).toThrow(/declared contentType/);
  });
  it.each([
    [{ ...bodySchema, additionalProperties: true }, {}],
    [
      {
        ...bodySchema,
        properties: {
          ...bodySchema.properties,
          file: { type: "string", format: "binary", maxLength: 100 },
        },
      },
      {},
    ],
    [bodySchema, { file: { contentType: "image/*" } }],
    [bodySchema, { purpose: { contentType: "application/problem+json\n" } }],
    [bodySchema, { file: { style: "form" } }],
    [
      bodySchema,
      { file: { headers: { "X-Part": { schema: { type: "string" } } } } },
    ],
    [
      bodySchema,
      { purpose: { headers: { "X-Part": { schema: { type: "string" } } } } },
    ],
    [bodySchema, { purpose: { style: "form", explode: false } }],
  ])("diagnoses unsupported multipart contracts (%j)", (schema, encoding) => {
    expect(compile(schema, encoding).unsupported).toHaveLength(1);
  });
  it("resolves body and binary-field references without mutating schemas", () => {
    const catalog = compile(
      { $ref: "#/components/schemas/Upload" },
      {},
      "spec",
      {
        schemas: {
          Upload: {
            ...bodySchema,
            properties: {
              ...bodySchema.properties,
              file: { $ref: "#/components/schemas/File" },
            },
          },
          File: { type: "string", format: "binary" },
        },
      },
    );
    expect(
      accepts(findOperation(catalog, "upload"), {
        body: { file, purpose: "evidence" },
      }),
    ).toBe(true);
    expect(bodySchema.properties.file).toEqual({
      type: "string",
      format: "binary",
    });
  });
  it.effect(
    "executes the pinned Stripe upload with its file server and bracket fields",
    () =>
      Effect.gen(function* () {
        const source = CORPUS.find((entry) => entry.name === "Stripe GA");
        if (source === undefined) throw new Error("Missing Stripe fixture");
        const fixture = yield* readFixture(source);
        const document = yield* Schema.decodeUnknownEffect(OPENAPI_SCHEMA)(
          parseOpenApi(fixture.text),
        );
        const catalog = compileOpenApi(
          { ...document, paths: { "/v1/files": document.paths["/v1/files"] } },
          {
            parameterProfile: "brackets-indexed",
            credentials: Object.fromEntries(
              Object.keys(document.components.securitySchemes).map((name) => [
                name,
                Redacted.make("fixture-token"),
              ]),
            ),
          },
        );
        const operation = catalog.operations.find(
          (item) => item.method === "post",
        );
        if (operation === undefined) throw new Error("Missing Stripe upload");
        const body: JsonObject = {
          file,
          purpose: "dispute_evidence",
          expand: ["links"],
          file_link_data: { create: true, metadata: { label: "A+B&é" } },
        };
        expect(accepts(operation, { body })).toBe(true);
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            expect(request.url).toBe("https://files.stripe.com/v1/files");
            expect(request.headers.authorization).toBe("Bearer fixture-token");
            if (
              request.body._tag !== "Uint8Array" ||
              request.headers["content-type"] === undefined
            )
              throw new Error("Missing multipart request");
            const parts = yield* readParts(
              request.body.body,
              request.headers["content-type"],
            );
            expect(parts.get("expand[0]")).toBe("links");
            expect(parts.get("file_link_data[create]")).toBe("true");
            expect(parts.get("file_link_data[metadata][label]")).toBe("A+B&é");
            return HttpClientResponse.fromWeb(
              request,
              new Response('{"id":"file_fixture"}', {
                headers: { "Content-Type": "application/json" },
              }),
            );
          }),
        );
        expect(yield* makeApiClient(http).execute(operation, { body })).toEqual(
          { id: "file_fixture" },
        );
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  it("does not permit file and ordinary fields to share a bracket namespace", () => {
    const schema = {
      ...bodySchema,
      properties: {
        ...bodySchema.properties,
        "file[name]": { type: "string" },
      },
    };
    const input: JsonValue = {
      file,
      purpose: "evidence",
      "file[name]": "collision",
    };
    expect(() =>
      encodeMultipartBody(input, descriptor(compile(schema)), 10000),
    ).toThrow(/conflict/);
  });
});
