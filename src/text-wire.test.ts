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

const TEXT = "\uFEFFRésumé\r\n😀";
const BODY = "Café +\r\n😀";
const spec = (openapi: string) => ({
  openapi,
  info: { title: "Ordinary UTF-8 text", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/text": {
      post: {
        operationId: "write_text",
        requestBody: {
          required: true,
          content: {
            "text/plain; charset=UTF-8": {
              schema: {
                type: "string",
                minLength: 3,
                maxLength: 64,
                pattern: "^Café",
              },
            },
          },
        },
        responses: {
          "200": { content: { "text/plain": { schema: { type: "string" } } } },
        },
      },
    },
    "/mixed": {
      get: {
        operationId: "mixed",
        responses: {
          "200": { content: { "text/plain": {}, "application/json": {} } },
        },
      },
    },
  },
});

it.live.each(["3.0.4", "3.1.2", "3.2.1"])(
  "exports native text constraints and preserves UTF-8 through the MCP string envelope (%s)",
  (openapi) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "openapi-mcp-text-wire-",
      });
      const location = join(directory, "text.json");
      yield* fs.writeFileString(location, JSON.stringify(spec(openapi)));
      const catalog = yield* loadOperationCatalog(location);
      expect(catalog.unsupported).toEqual([]);
      const requests = yield* Ref.make<
        Array<{
          method: string;
          url: string;
          body: number[];
          contentType: string | undefined;
          accept: string | undefined;
        }>
      >([]);
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Ref.update(requests, (previous) => [
            ...previous,
            {
              method: request.method,
              url: request.url,
              body:
                request.body._tag === "Uint8Array"
                  ? [...request.body.body]
                  : [],
              contentType: request.headers["content-type"],
              accept: request.headers.accept,
            },
          ]);
          return HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/mixed")
              ? Response.json({ ok: true })
              : new Response(new TextEncoder().encode(TEXT), {
                  headers: { "Content-Type": "Text/Plain; charset=utf-8" },
                }),
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
                { name: "text-wire-test", version: "1.0.0" },
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
        const textTool = listing.tools.find(
          (tool) => tool.name === "write_text",
        );
        expect(textTool?.inputSchema).toHaveProperty(
          "properties.body.type",
          "string",
        );
        expect(textTool?.inputSchema).toHaveProperty(
          "properties.body.minLength",
          3,
        );
        expect(textTool?.inputSchema).toHaveProperty(
          "properties.body.maxLength",
          64,
        );
        expect(textTool?.inputSchema).toHaveProperty(
          "properties.body.pattern",
          "^Café",
        );
        const result = yield* Effect.tryPromise(() =>
          client.callTool({ name: "write_text", arguments: { body: BODY } }),
        );
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ result: TEXT });
        for (const invalid of [
          "x",
          "Bad body",
          "Café\ud800",
          "Café" + "x".repeat(65),
          17,
          null,
          {},
          [],
        ]) {
          const failure = yield* Effect.tryPromise(() =>
            client.callTool({
              name: "write_text",
              arguments: { body: invalid },
            }),
          );
          expect(failure.isError).toBe(true);
        }
        const missing = yield* Effect.tryPromise(() =>
          client.callTool({ name: "write_text", arguments: {} }),
        );
        expect(missing.isError).toBe(true);
        expect(yield* Ref.get(requests)).toHaveLength(1);
        const json = yield* Effect.tryPromise(() =>
          client.callTool({ name: "mixed", arguments: {} }),
        );
        expect(json.isError).not.toBe(true);
        expect(json.structuredContent).toEqual({ ok: true });
        expect(yield* Ref.get(requests)).toEqual([
          {
            method: "POST",
            url: "https://api.example.com/v1/text",
            body: [
              0x43, 0x61, 0x66, 0xc3, 0xa9, 0x20, 0x2b, 0x0d, 0x0a, 0xf0, 0x9f,
              0x98, 0x80,
            ],
            contentType: "text/plain; charset=UTF-8",
            accept: "text/plain",
          },
          {
            method: "GET",
            url: "https://api.example.com/v1/mixed",
            body: [],
            contentType: undefined,
            accept: "application/json",
          },
        ]);
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
