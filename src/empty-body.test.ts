import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { InvalidArguments } from "./api-errors.ts";
import { makeApiClient } from "./api-client.ts";
import { compileOpenApi } from "./openapi.ts";
import type { HttpMethod } from "./openapi-types.ts";
import { accepts, findOperation } from "./test-fixtures.ts";

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const formBody = (schema: unknown = emptySchema, required = false) => ({
  required,
  content: { "application/x-www-form-urlencoded": { schema } },
});
const compile = (
  requestBody: unknown = formBody(),
  method: HttpMethod = "get",
  openapi = "3.1.2",
  baseUrl = new URL("https://api.example.com/"),
) =>
  compileOpenApi(
    {
      openapi,
      components: {
        requestBodies: { Empty: formBody() },
      },
      paths: {
        "/health": { get: { responses: { "204": {} } } },
        "/items": {
          [method]: {
            operationId: "items",
            requestBody,
            parameters: [
              {
                in: "query",
                name: "limit",
                schema: { type: "integer", minimum: 1 },
              },
            ],
            responses: { "204": {} },
          },
        },
      },
    },
    { baseUrl },
  );

describe("Empty optional form bodies on read methods", () => {
  for (const version of ["3.0.4", "3.1.2", "3.2.1"]) {
    it.each(["get", "head", "options"] as const)(
      `omits the empty body from %s tool arguments (${version})`,
      (method) => {
        const catalog = compile(formBody(), method, version);
        expect(catalog.unsupported).toEqual([]);
        const operation = findOperation(catalog, "items");
        expect(operation.body).toBeUndefined();
        expect(accepts(operation, {})).toBe(true);
        expect(accepts(operation, { query: { limit: 2 } })).toBe(true);
        expect(accepts(operation, { query: { limit: 0 } })).toBe(false);
        expect(accepts(operation, { body: {} })).toBe(false);
        expect(accepts(operation, { body: { unexpected: true } })).toBe(false);
      },
    );
  }

  it.each([
    { content: formBody().content },
    formBody({ type: "object", additionalProperties: false }),
    formBody({ ...emptySchema, required: [] }),
    { $ref: "#/components/requestBodies/Empty" },
  ])("recognizes default optionality and empty closed objects (%j)", (body) => {
    expect(compile(body).unsupported).toEqual([]);
    expect(findOperation(compile(body), "items").body).toBeUndefined();
  });

  it.each([
    ["required empty body", formBody(emptySchema, true)],
    [
      "optional properties",
      formBody({ ...emptySchema, properties: { q: { type: "string" } } }),
    ],
    ["open object", formBody({ type: "object", properties: {} })],
    ["untyped schema", formBody(true)],
    ["impossible schema", formBody(false)],
    [
      "required undeclared field",
      formBody({ ...emptySchema, required: ["q"] }),
    ],
    ["nullable body", formBody({ ...emptySchema, nullable: true })],
    [
      "pattern properties",
      formBody({
        ...emptySchema,
        patternProperties: { "^q": { type: "string" } },
      }),
    ],
    ["unsupported constraint", formBody({ ...emptySchema, not: {} })],
    ["schema reference", formBody({ $ref: "#/components/schemas/Unknown" })],
    ["invalid properties", formBody({ ...emptySchema, properties: [] })],
    ["nonempty minimum", formBody({ ...emptySchema, minProperties: 1 })],
    ["JSON body", { content: { "application/json": { schema: emptySchema } } }],
    [
      "alternative representation",
      {
        content: {
          ...formBody().content,
          "text/plain": { schema: { type: "string" } },
        },
      },
    ],
    [
      "undeclared encoding field",
      {
        content: {
          "application/x-www-form-urlencoded": {
            schema: emptySchema,
            encoding: { q: { style: "form" } },
          },
        },
      },
    ],
    [
      "sequential media",
      {
        content: {
          "application/x-www-form-urlencoded": {
            schema: emptySchema,
            itemSchema: {},
          },
        },
      },
    ],
  ])("preserves the diagnostic for %s", (_name, body) => {
    expect(compile(body).unsupported).toEqual([
      {
        method: "get",
        path: "/items",
        reason: "Read HTTP methods with request bodies are not supported.",
      },
    ]);
  });

  it.each(["post", "query"] as const)(
    "preserves empty form bodies for %s",
    (method) => {
      for (const required of [false, true]) {
        const operation = findOperation(
          compile(formBody(emptySchema, required), method, "3.2.1"),
          "items",
        );
        expect(operation.body?.mode).toBe("form");
        expect(accepts(operation, { body: {} })).toBe(true);
        expect(accepts(operation, {})).toBe(!required);
      }
    },
  );

  it.live(
    "sends query arguments without a body or body headers over HTTP",
    () =>
      Effect.gen(function* () {
        const requests: Array<{
          method: string | undefined;
          url: string | undefined;
          body: string;
          contentType: string | undefined;
          contentLength: string | undefined;
          transferEncoding: string | undefined;
        }> = [];
        const upstream = yield* Effect.acquireRelease(
          Effect.sync(() =>
            createServer((request, response) => {
              let body = "";
              request.setEncoding("utf8");
              request.on("data", (chunk: string) => {
                body += chunk;
              });
              request.on("end", () => {
                requests.push({
                  method: request.method,
                  url: request.url,
                  body,
                  contentType: request.headers["content-type"],
                  contentLength: request.headers["content-length"],
                  transferEncoding: request.headers["transfer-encoding"],
                });
                response.writeHead(204);
                response.end();
              });
            }),
          ),
          (server) =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
              server.closeAllConnections();
            }),
        );
        yield* Effect.tryPromise(() =>
          once(upstream.listen(0, "127.0.0.1"), "listening"),
        );
        const address = upstream.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die("Expected an upstream TCP address.");
        }
        const api = makeApiClient(yield* HttpClient.HttpClient);
        for (const method of ["get", "head", "options"] as const) {
          const operation = findOperation(
            compile(
              formBody(),
              method,
              "3.1.2",
              new URL(`http://127.0.0.1:${address.port}/`),
            ),
            "items",
          );
          expect(
            yield* Effect.flip(api.execute(operation, { body: {} })),
          ).toBeInstanceOf(InvalidArguments);
          expect(
            yield* api.execute(operation, { query: { limit: 2 } }),
          ).toBeNull();
        }
        expect(requests).toEqual(
          ["GET", "HEAD", "OPTIONS"].map((method) => ({
            method,
            url: "/items?limit=2",
            body: "",
            contentType: undefined,
            contentLength: undefined,
            transferEncoding: undefined,
          })),
        );
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
  );
});
