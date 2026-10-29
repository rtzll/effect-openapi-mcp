import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { Tool } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeApiClient } from "./api-client.ts";
import { parseOpenApi } from "./catalog.ts";
import { analyzeOpenApi, compileOpenApi } from "./openapi.ts";
import { bundleOpenApi } from "./references.ts";
import { accepts, findOperation } from "./test-fixtures.ts";

const NAMES = ["Accept", "Content-Type", "Authorization"] as const;
const document = (
  parameters: ReadonlyArray<unknown>,
  openapi = "3.1.2",
  inherited: ReadonlyArray<unknown> = [],
) => ({
  openapi,
  servers: [{ url: "https://api.example.com/" }],
  components: {
    parameters: {
      Accept: {
        in: "header",
        name: "Accept",
        required: true,
        schema: { $ref: "#/components/schemas/Missing" },
      },
      ContentType: {
        in: "header",
        name: "CONTENT-TYPE",
        content: { "application/xml": {} },
      },
    },
  },
  paths: {
    "/items": {
      parameters: inherited,
      post: {
        operationId: "create_item",
        parameters,
        requestBody: {
          content: {
            "application/vnd.example+json": { schema: { type: "object" } },
          },
        },
        responses: {
          "200": { content: { "application/vnd.example+json": {} } },
        },
      },
    },
  },
});

describe("OpenAPI reserved header parameters", () => {
  for (const openapi of ["3.0.4", "3.1.2", "3.2.1"]) {
    it.each(NAMES)(`ignores required %s declarations in ${openapi}`, (name) => {
      const catalog = compileOpenApi(
        document(
          [
            {
              in: "header",
              name,
              required: true,
              schema: false,
              content: { "application/xml": {} },
              style: "unsupported",
              allowReserved: true,
            },
          ],
          openapi,
        ),
      );
      const operation = findOperation(catalog, "create_item");
      expect(catalog.unsupported).toEqual([]);
      expect(operation.parameters).toEqual([]);
      expect(accepts(operation, {})).toBe(true);
      expect(accepts(operation, { headers: { [name]: "override" } })).toBe(
        false,
      );
      const schema = Tool.getJsonSchema(
        Tool.dynamic(operation.name, {
          parameters: operation.parametersSchema,
        }),
      );
      expect(schema).not.toHaveProperty("properties.headers");
    });
  }

  it("ignores case variants, duplicate definitions, inherited parameters and references", () => {
    const catalog = compileOpenApi(
      document(
        [
          { $ref: "#/components/parameters/Accept" },
          { in: "header", name: "accept", schema: { $ref: "#/missing" } },
          { $ref: "#/components/parameters/ContentType" },
          { in: "header", name: "aUtHoRiZaTiOn" },
          { in: "header", name: "X-Trace", schema: { type: "string" } },
        ],
        "3.1.2",
        NAMES.map((name) => ({ in: "header", name, required: true })),
      ),
    );
    const operation = findOperation(catalog, "create_item");
    expect(catalog.unsupported).toEqual([]);
    expect(operation.parameters.map((parameter) => parameter.name)).toEqual([
      "X-Trace",
    ]);
    expect(accepts(operation, { headers: { "X-Trace": "trace" } })).toBe(true);
  });

  it.effect.each(["none", "local", "same-origin"] as const)(
    "does not resolve ignored parameter schemas in %s reference mode",
    (mode) =>
      Effect.gen(function* () {
        const source = document([
          ...NAMES.map((name) => ({
            in: "header",
            name,
            schema: { $ref: "https://spec.example.com/unused.yaml#/Missing" },
          })),
          { $ref: "#/components/parameters/Accept" },
        ]);
        const assembled = yield* bundleOpenApi(
          parseOpenApi(JSON.stringify(source)),
          new URL("https://spec.example.com/openapi.yaml"),
          () =>
            Effect.die("An ignored parameter schema must never be fetched."),
          { mode, maxDocuments: 16, maxDepth: 16 },
        );
        expect(compileOpenApi(assembled).unsupported).toEqual([]);
      }),
  );

  it.each(NAMES)("retains non-header parameters named %s", (name) => {
    const operation = findOperation(
      compileOpenApi(
        document([
          { in: "query", name, required: true, schema: { type: "string" } },
        ]),
      ),
      "create_item",
    );
    expect(accepts(operation, {})).toBe(false);
    expect(accepts(operation, { query: { [name]: "value" } })).toBe(true);
  });

  it.each([
    "Host",
    "Cookie",
    "Connection",
    "Content-Length",
    "Transfer-Encoding",
  ])("continues rejecting transport header %s", (name) => {
    const catalog = analyzeOpenApi(
      document([{ in: "header", name, schema: { type: "string" } }]),
    );
    expect(catalog.operations).toEqual([]);
    expect(catalog.unsupported[0]?.reason).toBe(
      `Reserved header parameter: ${name}`,
    );
  });

  it("still rejects duplicate ordinary headers", () => {
    const catalog = analyzeOpenApi(
      document([
        { in: "header", name: "X-Trace", schema: { type: "string" } },
        { in: "header", name: "x-trace", schema: { type: "string" } },
      ]),
    );
    expect(catalog.operations).toEqual([]);
    expect(catalog.unsupported[0]?.reason).toContain(
      "Duplicate parameter declaration",
    );
  });

  const secured = () => ({
    ...document(NAMES.map((name) => ({ in: "header", name, required: true }))),
    security: [{ Token: [] }],
    components: {
      securitySchemes: { Token: { type: "http", scheme: "bearer" } },
    },
  });
  it("does not bypass a required security scheme", () => {
    const catalog = analyzeOpenApi(secured());
    expect(catalog.operations).toEqual([]);
    expect(catalog.unsupported[0]?.reason).toBe(
      "Missing credential for security scheme: Token",
    );
  });
  it.effect(
    "uses configured authentication and selected media on the HTTP request",
    () =>
      Effect.gen(function* () {
        const operation = findOperation(
          compileOpenApi(secured(), {
            credentials: { Token: Redacted.make("fixture-token") },
          }),
          "create_item",
        );
        const input = yield* Schema.decodeEffect(operation.parametersSchema, {
          onExcessProperty: "error",
        })({ body: { message: "hello" } });
        for (const name of NAMES)
          expect(
            accepts(operation, {
              body: input.body,
              headers: { [name]: "caller-override" },
            }),
          ).toBe(false);
        let calls = 0;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            calls++;
            expect(request.headers.authorization).toBe("Bearer fixture-token");
            expect(request.headers.accept).toBe("application/vnd.example+json");
            expect(request.headers["content-type"]).toBe(
              "application/vnd.example+json",
            );
            return HttpClientResponse.fromWeb(
              request,
              new Response("{}", {
                headers: { "Content-Type": "application/vnd.example+json" },
              }),
            );
          }),
        );
        expect(yield* makeApiClient(http).execute(operation, input)).toEqual(
          {},
        );
        expect(calls).toBe(1);
      }),
  );
});
