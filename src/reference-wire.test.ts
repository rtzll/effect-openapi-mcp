import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Ref } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpServer,
} from "effect/http";
import { NetAddress } from "effect/net";
import { HttpApi, makeApiClient } from "./api-client.ts";
import { loadOperationCatalog } from "./catalog.ts";
import { createMcpServer } from "./server.ts";
import { generatedTools } from "./tools.ts";

it.live.each(["3.0.4", "3.1.2", "3.2.1"])(
  "exports and executes recursive split request schemas through an independent MCP client (%s)",
  (openapi) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "openapi-mcp-reference-wire-",
      });
      const documents = {
        "entry.json": {
          openapi,
          info: { title: "Split inventory", version: "1.0.0" },
          servers: [{ url: "https://api.example.com/v1" }],
          paths: { "/items": { $ref: "routes.json#/paths/~1items" } },
        },
        "routes.json": {
          paths: {
            "/items": {
              post: {
                operationId: "create_item",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: { $ref: "models.json#/models/request" },
                    },
                  },
                },
                responses: {
                  "200": { content: { "application/json": {} } },
                },
              },
            },
          },
        },
        "models.json": {
          models: {
            request: {
              type: "object",
              required: ["code", "quantity"],
              additionalProperties: false,
              properties: {
                code: { type: "string", minLength: 2, maxLength: 4 },
                quantity: { type: "integer", minimum: 1 },
                children: {
                  type: "array",
                  items: { $ref: "#/models/request" },
                },
              },
            },
          },
        },
      };
      for (const [name, document] of Object.entries(documents)) {
        yield* fs.writeFileString(
          join(directory, name),
          JSON.stringify(document),
        );
      }
      const catalog = yield* loadOperationCatalog(
        join(directory, "entry.json"),
        { referencesMode: "local" },
      );
      expect(catalog.unsupported).toEqual([]);
      expect(catalog.operations.map((operation) => operation.name)).toEqual([
        "create_item",
      ]);
      const requests = yield* Ref.make<
        Array<{ method: string; url: string; body: string }>
      >([]);
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.body._tag !== "Uint8Array") {
            return yield* Effect.die("Expected native JSON request bytes");
          }
          const body = new TextDecoder().decode(request.body.body);
          yield* Ref.update(requests, (requests) => [
            ...requests,
            {
              method: request.method,
              url: request.url,
              body,
            },
          ]);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ accepted: true }),
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
                { name: "split-spec-test", version: "1.0.0" },
                { versionNegotiation: { mode: { pin: "2026-07-28" } } },
              ),
          ),
          (client) =>
            Effect.tryPromise(() => client.close()).pipe(Effect.orDie),
        );
        yield* Effect.tryPromise(() =>
          client.connect(new StreamableHTTPClientTransport(endpoint)),
        );
        const listing = yield* Effect.tryPromise(() => client.listTools());
        expect(listing.tools.map((tool) => tool.name)).toEqual(["create_item"]);
        expect(JSON.stringify(listing.tools[0]?.inputSchema)).toContain(
          '"minLength":2',
        );
        const body = {
          code: "AB",
          quantity: 2,
          children: [{ code: "CD", quantity: 1 }],
        };
        const success = yield* Effect.tryPromise(() =>
          client.callTool({ name: "create_item", arguments: { body } }),
        );
        expect(success.isError).not.toBe(true);
        expect(success.structuredContent).toEqual({ accepted: true });
        expect(yield* Ref.get(requests)).toEqual([
          {
            method: "POST",
            url: "https://api.example.com/v1/items",
            body: JSON.stringify(body),
          },
        ]);
        for (const invalid of [
          { ...body, code: "A" },
          { ...body, children: [{ code: "CD", quantity: 0 }] },
          { ...body, unexpected: true },
        ]) {
          const failure = yield* Effect.tryPromise(() =>
            client.callTool({
              name: "create_item",
              arguments: { body: invalid },
            }),
          );
          expect(failure.isError).toBe(true);
        }
        expect(yield* Ref.get(requests)).toHaveLength(1);
      }).pipe(
        Effect.provide(
          createMcpServer(generatedTools(catalog), {
            port: 0,
            logAddress: false,
          }).pipe(Layer.provide(Layer.succeed(HttpApi, makeApiClient(http)))),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide([NodeFileSystem.layer, FetchHttpClient.layer]),
    ),
);
