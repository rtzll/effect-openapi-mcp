import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Ref, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpServer,
} from "effect/http";
import { NetAddress } from "effect/net";
import { HttpApi, makeApiClient } from "./api-client.ts";
import { compileOpenApi } from "./openapi.ts";
import { createMcpServer } from "./server.ts";
import { API_RESPONSES, findOperation } from "./test-fixtures.ts";
import { generatedTools } from "./tools.ts";

// Each era executes 12 generated valid calls and 12 invalid mutations, 48 calls total.
const SAMPLE_COUNT = 4;
const SEEDS = { query: 731, json: 732, text: 733 } as const;
const labels = ["a b", "x&y", "c,d", "Café", "😀", ""];
const labelSchema = { type: "string", enum: labels };
const boundedInteger = { type: "integer", minimum: 1, maximum: 9 };
const SPEC = {
  openapi: "3.2.1",
  info: { title: "Generated wire contracts", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/text": {
      post: {
        operationId: "text_tool",
        tags: ["generated"],
        requestBody: {
          required: true,
          content: {
            "text/plain": {
              schema: {
                type: "string",
                minLength: 3,
                maxLength: 32,
                enum: [
                  "Café +\r\n😀",
                  "hello &<>\n",
                  "zero: 0\n",
                  "false: false",
                ],
              },
            },
          },
        },
        responses: { "200": { content: { "text/plain": {} } } },
      },
    },
    "/query": {
      get: {
        operationId: "query_tool",
        tags: ["generated"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: true,
            schema: boundedInteger,
          },
          {
            name: "enabled",
            in: "query",
            required: true,
            schema: { type: "boolean" },
          },
          { name: "term", in: "query", required: true, schema: labelSchema },
          {
            name: "tags",
            in: "query",
            required: true,
            style: "form",
            explode: true,
            schema: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: labelSchema,
            },
          },
        ],
        responses: API_RESPONSES,
      },
    },
    "/json": {
      post: {
        operationId: "json_tool",
        tags: ["generated"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["count", "enabled", "tag", "values"],
                properties: {
                  count: boundedInteger,
                  enabled: { type: "boolean" },
                  tag: labelSchema,
                  values: {
                    type: "array",
                    minItems: 1,
                    maxItems: 3,
                    items: { type: "integer", minimum: 0, maximum: 4 },
                  },
                },
              },
            },
          },
        },
        responses: API_RESPONSES,
      },
    },
    "/hidden": {
      get: {
        operationId: "hidden_tool",
        tags: ["hidden"],
        parameters: [
          { name: "cookie", in: "cookie", schema: { type: "string" } },
        ],
        responses: API_RESPONSES,
      },
    },
    "/deleted": {
      delete: {
        operationId: "deleted_tool",
        tags: ["generated"],
        responses: API_RESPONSES,
      },
    },
  },
};
const OPTIONS = { methods: ["get", "post"], tags: ["generated"] } as const;
const QUERY_MODEL = Schema.Struct({
  query: Schema.Struct({
    limit: Schema.Finite,
    enabled: Schema.Boolean,
    term: Schema.String,
    tags: Schema.Array(Schema.String),
  }),
});
const JSON_BODY = Schema.Struct({
  count: Schema.Finite,
  enabled: Schema.Boolean,
  tag: Schema.String,
  values: Schema.Array(Schema.Finite),
});
const JSON_MODEL = Schema.Struct({ body: JSON_BODY });
const TEXT_MODEL = Schema.Struct({ body: Schema.String });

it.live.each(["modern", "legacy"] as const)(
  "preserves 12 generated valid calls and rejects 12 mutations over %s MCP",
  (era) =>
    Effect.gen(function* () {
      const catalog = compileOpenApi(SPEC, OPTIONS);
      expect(catalog.unsupported).toEqual([]);
      expect(catalog.filtered).toHaveLength(2);
      const reordered = compileOpenApi(
        {
          ...SPEC,
          paths: Object.fromEntries(Object.entries(SPEC.paths).reverse()),
        },
        OPTIONS,
      );
      expect(reordered.operations.map((operation) => operation.name)).toEqual(
        catalog.operations.map((operation) => operation.name),
      );
      const query = findOperation(catalog, "query_tool");
      const json = findOperation(catalog, "json_tool");
      const text = findOperation(catalog, "text_tool");
      const querySamples = yield* Arbitrary.sampleEffect(
        Arbitrary.schema(Schema.toEncoded(query.parametersSchema)),
        { seed: SEEDS.query, count: SAMPLE_COUNT, size: 3 },
      ).pipe(
        Effect.flatMap((values) =>
          Effect.forEach(values, (value) =>
            Schema.decodeUnknownEffect(QUERY_MODEL)(value),
          ),
        ),
      );
      const jsonSamples = yield* Arbitrary.sampleEffect(
        Arbitrary.schema(Schema.toEncoded(json.parametersSchema)),
        { seed: SEEDS.json, count: SAMPLE_COUNT, size: 3 },
      ).pipe(
        Effect.flatMap((values) =>
          Effect.forEach(values, (value) =>
            Schema.decodeUnknownEffect(JSON_MODEL)(value),
          ),
        ),
      );
      const textSamples = yield* Arbitrary.sampleEffect(
        Arbitrary.schema(Schema.toEncoded(text.parametersSchema)),
        { seed: SEEDS.text, count: SAMPLE_COUNT, size: 3 },
      ).pipe(
        Effect.flatMap((values) =>
          Effect.forEach(values, (value) =>
            Schema.decodeUnknownEffect(TEXT_MODEL)(value),
          ),
        ),
      );
      for (const samples of [querySamples, jsonSamples, textSamples]) {
        expect(samples).toHaveLength(SAMPLE_COUNT);
        expect(
          new Set(samples.map((sample) => JSON.stringify(sample))).size,
        ).toBeGreaterThan(1);
      }
      const requests = yield* Ref.make<
        Array<{
          method: string;
          url: string;
          body: string;
          bytes: number[];
          contentType: string | undefined;
        }>
      >([]);
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          const body =
            request.body._tag === "Uint8Array"
              ? new TextDecoder("utf-8", { fatal: true }).decode(
                  request.body.body,
                )
              : "";
          yield* Ref.update(requests, (previous) => [
            ...previous,
            {
              method: request.method,
              url: request.url,
              body,
              bytes:
                request.body._tag === "Uint8Array"
                  ? [...request.body.body]
                  : [],
              contentType: request.headers["content-type"],
            },
          ]);
          return HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/text")
              ? new Response(`accepted:\n${body}`, {
                  headers: { "Content-Type": "text/plain; charset=utf-8" },
                })
              : Response.json({ accepted: true }),
          );
        }),
      );
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const endpoint = new URL(
          "/mcp",
          NetAddress.formatUrlUnsafe(server.address),
        );
        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Client(
                { name: "generated-wire-test", version: "1.0.0" },
                {
                  versionNegotiation: {
                    mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" },
                  },
                },
              ),
          ),
          (client) =>
            Effect.tryPromise(() => client.close()).pipe(Effect.orDie),
        );
        yield* Effect.tryPromise(() =>
          client.connect(new StreamableHTTPClientTransport(endpoint)),
        );
        expect(client.getProtocolEra()).toBe(era);
        const listing = yield* Effect.tryPromise(() => client.listTools());
        expect(listing.tools.map((tool) => tool.name)).toEqual([
          "json_tool",
          "query_tool",
          "text_tool",
        ]);
        expect(yield* Ref.get(requests)).toEqual([]);
        for (const [index, input] of querySamples.entries()) {
          const success = yield* Effect.tryPromise(() =>
            client.callTool({ name: "query_tool", arguments: input }),
          );
          expect(success.isError).not.toBe(true);
          expect(success.structuredContent).toEqual({ accepted: true });
          const captured = (yield* Ref.get(requests)).at(-1);
          if (captured === undefined)
            return yield* Effect.die("Missing generated query request");
          const url = new URL(captured.url);
          expect(url.origin + url.pathname).toBe(
            "https://api.example.com/v1/query",
          );
          expect([...url.searchParams]).toEqual([
            ["limit", String(input.query.limit)],
            ["enabled", String(input.query.enabled)],
            ["term", input.query.term],
            ...input.query.tags.map((tag) => ["tags", tag]),
          ]);
          expect(captured.method).toBe("GET");
          expect(captured.body).toBe("");
          expect(captured.contentType).toBeUndefined();
          const before = (yield* Ref.get(requests)).length;
          const failure = yield* Effect.tryPromise(() =>
            client.callTool({
              name: "query_tool",
              arguments: {
                query: {
                  ...input.query,
                  limit: index % 2 === 0 ? 0 : "wrong type",
                },
              },
            }),
          );
          expect(failure.isError).toBe(true);
          expect(yield* Ref.get(requests)).toHaveLength(before);
        }
        for (const [index, input] of jsonSamples.entries()) {
          const success = yield* Effect.tryPromise(() =>
            client.callTool({ name: "json_tool", arguments: input }),
          );
          expect(success.isError).not.toBe(true);
          expect(success.structuredContent).toEqual({ accepted: true });
          const captured = (yield* Ref.get(requests)).at(-1);
          if (captured === undefined)
            return yield* Effect.die("Missing generated JSON request");
          expect(captured.url).toBe("https://api.example.com/v1/json");
          expect(captured.method).toBe("POST");
          expect(captured.contentType).toBe("application/json");
          const parsed: unknown = JSON.parse(captured.body);
          expect(yield* Schema.decodeUnknownEffect(JSON_BODY)(parsed)).toEqual(
            input.body,
          );
          const before = (yield* Ref.get(requests)).length;
          const body =
            index % 2 === 0
              ? { ...input.body, count: 10 }
              : { ...input.body, enabled: "wrong type" };
          const failure = yield* Effect.tryPromise(() =>
            client.callTool({ name: "json_tool", arguments: { body } }),
          );
          expect(failure.isError).toBe(true);
          expect(yield* Ref.get(requests)).toHaveLength(before);
        }
        for (const [index, input] of textSamples.entries()) {
          const success = yield* Effect.tryPromise(() =>
            client.callTool({ name: "text_tool", arguments: input }),
          );
          expect(success.isError).not.toBe(true);
          expect(success.structuredContent).toEqual({
            result: `accepted:\n${input.body}`,
          });
          const captured = (yield* Ref.get(requests)).at(-1);
          if (captured === undefined)
            return yield* Effect.die("Missing generated text request");
          expect(captured.url).toBe("https://api.example.com/v1/text");
          expect(captured.method).toBe("POST");
          expect(captured.contentType).toBe("text/plain");
          expect(captured.body).toBe(input.body);
          expect(captured.bytes).toEqual([...Buffer.from(input.body, "utf8")]);
          const before = (yield* Ref.get(requests)).length;
          const failure = yield* Effect.tryPromise(() =>
            client.callTool({
              name: "text_tool",
              arguments: {
                body:
                  index % 2 === 0
                    ? input.body + "x".repeat(40)
                    : { text: input.body },
              },
            }),
          );
          expect(failure.isError).toBe(true);
          expect(yield* Ref.get(requests)).toHaveLength(before);
        }
        expect(yield* Ref.get(requests)).toHaveLength(3 * SAMPLE_COUNT);
      }).pipe(
        Effect.provide(
          createMcpServer(generatedTools(catalog), {
            port: 0,
            logAddress: false,
          }).pipe(Layer.provide(Layer.succeed(HttpApi, makeApiClient(http)))),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
);
