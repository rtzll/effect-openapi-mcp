import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Scope,
  ScopedRef,
} from "effect";
import { FetchHttpClient, HttpServer } from "effect/http";
import { NetAddress } from "effect/net";
import { describe, expect, it } from "@effect/vitest";
import { loadOperationCatalog } from "./catalog.ts";
import { isJsonMediaType } from "./media-type.ts";
import { compileOpenApi, type OperationCatalog } from "./openapi.ts";
import { readPublicSpec } from "./public-fixtures.ts";
import {
  API_RESPONSES,
  inventoryCatalog,
  testServerLayer,
  TEST_CREDENTIALS,
  TEST_KEY,
  TICKETING_SPEC,
} from "./test-fixtures.ts";

type RecordedRequest = Readonly<{
  method: string | undefined;
  url: URL;
  headers: IncomingHttpHeaders;
  body: unknown;
  rawBody: string;
  rawBytes: Uint8Array<ArrayBuffer>;
}>;
type Reply = Readonly<{
  status?: number;
  body?: unknown;
  raw?: string | Uint8Array;
  headers?: Record<string, string>;
  hang?: boolean;
  hangBody?: boolean;
}>;
const CODEC_SPEC = {
  openapi: "3.1.0",
  security: [{ Key: [] }],
  components: {
    securitySchemes: {
      Key: { type: "apiKey", in: "header", name: "X-API-KEY" },
    },
  },
  paths: {
    "/codec/{id}": {
      get: {
        operationId: "read_codec",
        parameters: [
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "query",
            name: "tags",
            schema: { type: "array", items: { type: "string" } },
          },
          {
            in: "query",
            name: "numbers",
            explode: false,
            schema: { type: "array", items: { type: "integer" } },
          },
          { in: "query", name: "empty", schema: { type: "string" } },
          {
            in: "query",
            name: "optional",
            schema: { type: ["string", "null"] },
          },
          { in: "query", name: "enabled", schema: { type: "boolean" } },
          {
            in: "header",
            name: "X-Trace",
            schema: { type: "array", items: { type: "string" } },
          },
        ],
        responses: API_RESPONSES,
      },
    },
    "/json": {
      post: {
        operationId: "write_json",
        requestBody: {
          required: true,
          content: {
            "application/problem+json": {
              schema: {
                type: ["string", "array", "null"],
                items: { type: "integer" },
              },
            },
          },
        },
        responses: API_RESPONSES,
      },
    },
    "/health": { head: { operationId: "health", responses: { "200": {} } } },
    "/replace": {
      put: {
        operationId: "replace",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["value"],
                properties: { value: { type: "integer" } },
              },
            },
          },
        },
        responses: API_RESPONSES,
      },
    },
  },
};
const listen = (server: Server) =>
  Effect.tryPromise(async (signal) => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Missing test address");
    }
    return new URL(`http://127.0.0.1:${address.port}/`);
  });
const stop = (server: Server) =>
  Effect.tryPromise(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  });

const acquireServer = Effect.fn(function* (
  ...arguments_: Parameters<typeof testServerLayer>
) {
  // The child scope also lets the lifecycle test close the server while its
  // independent MCP client still has an outstanding request.
  const scope = yield* Scope.fork(yield* Effect.scope);
  const services = yield* Layer.buildWithScope(
    testServerLayer(...arguments_),
    scope,
  );
  const server = Context.get(services, HttpServer.HttpServer);
  return {
    endpoint: new URL("/mcp", NetAddress.formatUrlUnsafe(server.address)),
    close: Scope.close(scope, Exit.void),
  };
});
const acquireClient = (create: () => Client) =>
  Effect.acquireRelease(Effect.sync(create), (client) =>
    Effect.tryPromise(() => client.close()).pipe(Effect.orDie),
  );
const connect = Effect.fn(function* (
  catalog: OperationCatalog,
  timeoutMs: number = 1000,
) {
  const server = yield* acquireServer(catalog, timeoutMs);
  const client = yield* acquireClient(
    () =>
      new Client(
        { name: "adapter-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      ),
  );
  yield* Effect.tryPromise(() =>
    client.connect(new StreamableHTTPClientTransport(server.endpoint)),
  );
  return { server, client, catalog, endpoint: server.endpoint };
});
const makeFixture = Effect.gen(function* () {
  const requests: RecordedRequest[] = [];
  const abortedPaths: string[] = [];
  const replies = new Map<string, Reply>();
  const upstream = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createServer((request, response) => {
        const chunks: Uint8Array[] = [];
        request.on("data", (chunk: Uint8Array) => {
          chunks.push(chunk);
        });
        request.on("end", () => {
          const rawBytes = Buffer.concat(chunks);
          const text = rawBytes.toString("utf8");
          const url = new URL(request.url ?? "/", "http://localhost");
          requests.push({
            method: request.method,
            url,
            headers: request.headers,
            body:
              text === ""
                ? undefined
                : isJsonMediaType(request.headers["content-type"] ?? "")
                  ? JSON.parse(text)
                  : text,
            rawBody: text,
            rawBytes,
          });
          response.on("close", () => {
            if (!response.writableEnded) {
              abortedPaths.push(url.pathname);
            }
          });
          const reply = replies.get(url.pathname) ?? {
            body: {
              id: "it_1",
              results: [{ id: "it_2" }],
              pagination: { next_cursor: "it_3", previous_cursor: null },
              metadata: { source: "inventory" },
            },
          };
          if (reply.hang === true) {
            return;
          }
          response.writeHead(reply.status ?? 200, {
            "Content-Type": "application/json",
            ...reply.headers,
          });
          if (reply.hangBody === true) {
            response.flushHeaders();
            return;
          }
          response.end(reply.raw ?? JSON.stringify(reply.body));
        });
      }),
    ),
    (server) =>
      server.listening ? stop(server).pipe(Effect.orDie) : Effect.void,
  );
  const baseUrl = new URL("v1/", yield* listen(upstream));
  const active = yield* ScopedRef.fromAcquire(
    connect(inventoryCatalog({ baseUrl })),
  );
  const useCatalog = Effect.fn(function* (
    catalog: OperationCatalog,
    timeoutMs: number = 1000,
  ) {
    yield* ScopedRef.set(active, connect(catalog, timeoutMs));
    return yield* ScopedRef.get(active);
  });
  return {
    baseUrl,
    requests,
    abortedPaths,
    replies,
    useCatalog,
    session: yield* ScopedRef.get(active),
  };
});

describe("Generic Effect MCP server", () => {
  it.live.each(["2026-07-28", "2025-11-25"] as const)(
    "preserves YAML files as text through MCP %s",
    (version) =>
      Effect.gen(function* () {
        const { baseUrl, requests, replies } = yield* makeFixture;
        const catalog = compileOpenApi(
          {
            openapi: "3.1.0",
            paths: {
              "/config": {
                get: {
                  operationId: "get_config",
                  responses: { "200": { content: { "application/yaml": {} } } },
                },
              },
            },
          },
          { baseUrl },
        );
        const server = yield* acquireServer(catalog);
        const client = yield* acquireClient(
          () =>
            new Client(
              { name: "yaml-test", version: "1.0.0" },
              {
                versionNegotiation: {
                  mode: version === "2026-07-28" ? { pin: version } : "legacy",
                },
              },
            ),
        );
        yield* Effect.tryPromise(() =>
          client.connect(new StreamableHTTPClientTransport(server.endpoint)),
        );
        const text =
          "\uFEFF# preserve comments\r\napiVersion: v1\r\nname: Café 😀\r\n";
        replies.set("/v1/config", {
          raw: text,
          headers: { "Content-Type": "application/yaml" },
        });
        const result = yield* Effect.tryPromise(() =>
          client.callTool({ name: "get_config", arguments: {} }),
        );
        expect(result).toMatchObject({
          structuredContent: { result: text },
          content: [{ type: "text", text: JSON.stringify({ result: text }) }],
        });
        expect(requests.at(-1)?.headers.accept).toBe("application/yaml");
      }),
  );
  it.live.each(["2026-07-28", "2025-11-25"] as const)(
    "rejects form encoding expansion before forwarding an MCP %s call",
    (version) =>
      Effect.gen(function* () {
        const { baseUrl, requests } = yield* makeFixture;
        const catalog = compileOpenApi(
          {
            openapi: "3.1.0",
            paths: {
              "/forms": {
                post: {
                  operationId: "submit_form",
                  requestBody: {
                    required: true,
                    content: {
                      "application/x-www-form-urlencoded": {
                        schema: {
                          type: "object",
                          additionalProperties: false,
                          required: ["value"],
                          properties: { value: { type: "string" } },
                        },
                      },
                    },
                  },
                  responses: API_RESPONSES,
                },
              },
            },
          },
          { baseUrl },
        );
        const server = yield* acquireServer(catalog, 1000, {
          maxRequestBytes: 1024,
        });
        const client = yield* acquireClient(
          () =>
            new Client(
              { name: "request-limit-test", version: "1.0.0" },
              {
                versionNegotiation: {
                  mode: version === "2026-07-28" ? { pin: version } : "legacy",
                },
              },
            ),
        );
        yield* Effect.tryPromise(() =>
          client.connect(new StreamableHTTPClientTransport(server.endpoint)),
        );
        // The JSON tool argument fits the incoming limit; percent encoding expands
        // each four-byte emoji into twelve bytes in the upstream form body.
        const failure = yield* Effect.tryPromise(() =>
          client.callTool({
            name: "submit_form",
            arguments: { body: { value: "😀".repeat(100) } },
          }),
        );
        expect(failure.isError).toBe(true);
        expect(JSON.stringify(failure.content)).toContain(
          "The request body exceeded the configured byte limit.",
        );
        expect(requests).toHaveLength(0);
        const success = yield* Effect.tryPromise(() =>
          client.callTool({
            name: "submit_form",
            arguments: { body: { value: "ok" } },
          }),
        );
        expect(success.isError).not.toBe(true);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.rawBody).toBe("value=ok");
      }),
  );
  it.live.each(["2026-07-28", "2025-11-25"] as const)(
    "uploads exact file bytes from MCP arguments over %s",
    (version) =>
      Effect.gen(function* () {
        const { baseUrl, requests, replies } = yield* makeFixture;
        const catalog = compileOpenApi(
          {
            openapi: "3.1.0",
            paths: {
              "/files": {
                post: {
                  operationId: "upload_file",
                  requestBody: {
                    required: true,
                    content: {
                      "multipart/form-data": {
                        schema: {
                          type: "object",
                          additionalProperties: false,
                          required: ["file", "purpose"],
                          properties: {
                            file: { type: "string", format: "binary" },
                            purpose: { type: "string", enum: ["evidence"] },
                          },
                        },
                      },
                    },
                  },
                  responses: API_RESPONSES,
                },
              },
            },
          },
          { baseUrl },
        );
        const server = yield* acquireServer(catalog);
        const client = yield* acquireClient(
          () =>
            new Client(
              { name: "upload-test", version: "1.0.0" },
              {
                versionNegotiation: {
                  mode: version === "2026-07-28" ? { pin: version } : "legacy",
                },
              },
            ),
        );
        yield* Effect.tryPromise(() =>
          client.connect(new StreamableHTTPClientTransport(server.endpoint)),
        );
        replies.set("/v1/files", { body: { id: "file_fixture" } });
        const data = new Uint8Array([0, 1, 255, 128]);
        const arguments_ = {
          body: {
            file: {
              dataBase64: Buffer.from(data).toString("base64"),
              filename: "evidence.bin",
              mediaType: "application/octet-stream",
            },
            purpose: "evidence",
          },
        };
        const result = yield* Effect.tryPromise(() =>
          client.callTool({ name: "upload_file", arguments: arguments_ }),
        );
        expect(result).toHaveProperty("structuredContent.id", "file_fixture");
        expect(requests).toHaveLength(1);
        const request = requests[0];
        if (request === undefined) throw new Error("Missing upload request.");
        const form = yield* Effect.tryPromise(() =>
          new Response(request.rawBytes, {
            headers: { "Content-Type": request.headers["content-type"] ?? "" },
          }).formData(),
        );
        expect(form.get("purpose")).toBe("evidence");
        const file = form.get("file");
        if (file === null || typeof file === "string")
          throw new Error("Missing uploaded file.");
        expect(file.name).toBe("evidence.bin");
        expect(file.type).toBe("application/octet-stream");
        expect(
          new Uint8Array(yield* Effect.tryPromise(() => file.arrayBuffer())),
        ).toEqual(data);
        const invalid = yield* Effect.tryPromise(() =>
          client.callTool({
            name: "upload_file",
            arguments: {
              body: {
                ...arguments_.body,
                file: { ...arguments_.body.file, dataBase64: "%%%" },
              },
            },
          }),
        );
        expect(invalid).toHaveProperty("isError", true);
        expect(requests).toHaveLength(1);
      }),
  );
  it.live.each(["2026-07-28", "2025-11-25"] as const)(
    "returns bounded PDF bytes as a structured base64 result over MCP %s",
    (version) =>
      Effect.gen(function* () {
        const { baseUrl, replies, requests } = yield* makeFixture;
        const catalog = compileOpenApi(
          {
            openapi: "3.1.0",
            paths: {
              "/pdf": {
                get: {
                  operationId: "download_pdf",
                  responses: { "200": { content: { "application/pdf": {} } } },
                },
              },
            },
          },
          { baseUrl },
        );
        const server = yield* acquireServer(catalog);
        const client = yield* acquireClient(
          () =>
            new Client(
              { name: "binary-test", version: "1.0.0" },
              {
                versionNegotiation: {
                  mode: version === "2026-07-28" ? { pin: version } : "legacy",
                },
              },
            ),
        );
        yield* Effect.tryPromise(() =>
          client.connect(new StreamableHTTPClientTransport(server.endpoint)),
        );
        const bytes = new Uint8Array([37, 80, 68, 70, 0, 255, 128]);
        replies.set("/v1/pdf", {
          raw: bytes,
          headers: { "Content-Type": "application/pdf" },
        });
        const expected = {
          mimeType: "application/pdf",
          dataBase64: Buffer.from(bytes).toString("base64"),
        };
        const result = yield* Effect.tryPromise(() =>
          client.callTool({ name: "download_pdf", arguments: {} }),
        );
        expect(result).toMatchObject({
          structuredContent: expected,
          content: [{ type: "text", text: JSON.stringify(expected) }],
        });
        expect(requests.at(-1)?.headers.accept).toBe("application/pdf");
      }),
  );
  it.live(
    "discovers generated native Effect schemas without calling the API",
    () =>
      Effect.gen(function* () {
        const { session, requests } = yield* makeFixture;
        expect(session.client.getProtocolEra()).toBe("modern");
        const { tools } = yield* Effect.tryPromise(() =>
          session.client.listTools(),
        );
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          "create_item",
          "delete_item",
          "get_item",
          "list_items",
          "search_items",
          "update_item",
        ]);
        expect(
          tools.find((tool) => tool.name === "get_item")?.inputSchema,
        ).toHaveProperty("properties.path.required", ["id"]);
        expect(JSON.stringify(tools)).not.toContain(TEST_KEY);
        expect(requests).toHaveLength(0);
      }),
  );
  it.live("rejects oversized HTTP requests before forwarding", () =>
    Effect.gen(function* () {
      const { session, requests } = yield* makeFixture;
      const limited = yield* acquireServer(session.catalog, 1000, {
        maxRequestBytes: 512,
      });
      const response = yield* Effect.tryPromise(() =>
        fetch(limited.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "get_item",
              arguments: { path: { id: "x".repeat(1024) } },
            },
          }),
        }),
      );
      expect(response.status).toBe(413);
      expect(requests).toHaveLength(0);
    }),
  );
  it.live(
    "bounds chunked messages and remains usable after closing an oversized stream",
    () =>
      Effect.gen(function* () {
        const { session, requests } = yield* makeFixture;
        const limited = yield* acquireServer(session.catalog, 1000, {
          maxRequestBytes: 512,
        });
        const send = (id: string) =>
          new Promise<
            { status: number | undefined; body: string } | { reset: true }
          >((resolve, reject) => {
            const request = httpRequest(
              limited.endpoint,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json, text/event-stream",
                  "Transfer-Encoding": "chunked",
                  "MCP-Protocol-Version": "2026-07-28",
                  "Mcp-Method": "tools/call",
                  "Mcp-Name": "get_item",
                },
              },
              (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                  body += chunk;
                });
                response.on("end", () =>
                  resolve({ status: response.statusCode, body }),
                );
                response.on("error", reject);
              },
            );
            request.on("error", (error: NodeJS.ErrnoException) => {
              if (error.code === "ECONNRESET") resolve({ reset: true });
              else reject(error);
            });
            const payload = JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "get_item",
                arguments: { path: { id } },
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientInfo": {
                    name: "bounded-test",
                    version: "1",
                  },
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            });
            request.write(payload.slice(0, 100));
            request.end(payload.slice(100));
          });
        const oversized = yield* Effect.tryPromise(() =>
          send("it_" + "x".repeat(1024)),
        );
        if ("status" in oversized) {
          expect(oversized.status).toBe(413);
        } else expect(oversized.reset).toBe(true);
        expect(requests).toHaveLength(0);
        const control = yield* Effect.tryPromise(() => send("it_1"));
        if (!("status" in control))
          throw new Error("The valid control request was closed.");
        expect(control.status).toBe(200);
        expect(control.body).toContain("it_1");
        expect(requests).toHaveLength(1);
      }),
  );
  it.live("accepts a stateless tools/list request without initialization", () =>
    Effect.gen(function* () {
      const { session } = yield* makeFixture;
      const response = yield* Effect.tryPromise(() =>
        fetch(session.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/list",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "standalone",
                  version: "1.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Mcp-Session-Id")).toBeNull();
      expect(yield* Effect.tryPromise(() => response.json())).toHaveProperty(
        "result.tools.length",
        6,
      );
    }),
  );
  it.live("supports older MCP clients", () =>
    Effect.gen(function* () {
      const { session } = yield* makeFixture;
      const legacy = yield* acquireClient(
        () => new Client({ name: "legacy", version: "1.0.0" }),
      );
      yield* Effect.tryPromise(() =>
        legacy.connect(new StreamableHTTPClientTransport(session.endpoint)),
      );
      expect(legacy.getProtocolEra()).toBe("legacy");
      expect(
        yield* Effect.tryPromise(() =>
          legacy.callTool({
            name: "get_item",
            arguments: { path: { id: "it_1" } },
          }),
        ),
      ).toHaveProperty("structuredContent.id", "it_1");
    }),
  );
  it.live.each(["2025-03-26", "2025-06-18", "2025-11-25"])(
    "negotiates an explicitly requested %s client",
    (version) =>
      Effect.gen(function* () {
        const { session, requests } = yield* makeFixture;
        const response = yield* Effect.tryPromise(() =>
          fetch(session.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: version,
                capabilities: {},
                clientInfo: { name: "raw-legacy-client", version: "1.0.0" },
              },
            }),
          }),
        );
        expect(response.status).toBe(200);
        const text = yield* Effect.tryPromise(() => response.text());
        const json = text.startsWith("{")
          ? text
          : text.match(/^data:\s*(.+)$/m)?.[1];
        if (json === undefined) {
          throw new Error("Missing initialization response.");
        }
        const result: unknown = JSON.parse(json);
        expect(result).toHaveProperty("result.protocolVersion", version);
        const sessionId = response.headers.get("Mcp-Session-Id");
        if (sessionId === null) {
          throw new Error("Missing legacy MCP session.");
        }
        const discovery = yield* Effect.tryPromise(() =>
          fetch(session.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "Mcp-Session-Id": sessionId,
              "MCP-Protocol-Version": version,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/list",
              params: {},
            }),
          }),
        );
        expect(discovery.status).toBe(200);
        expect(yield* Effect.tryPromise(() => discovery.text())).toContain(
          '"name":"get_item"',
        );
        expect(requests).toHaveLength(0);
      }),
  );
  it.live.each(["__proto__", "constructor", "toString"])(
    "supports a prototype-like tool name safely: %s",
    (operationId) =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl } = yield* makeFixture;

        const spec = {
          openapi: "3.1.0",
          paths: {
            "/value": { get: { operationId, responses: API_RESPONSES } },
          },
        };
        const session = yield* useCatalog(compileOpenApi(spec, { baseUrl }));
        expect(
          (yield* Effect.tryPromise(() =>
            session.client.listTools(),
          )).tools.map((tool) => tool.name),
        ).toEqual([operationId]);
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({ name: operationId, arguments: {} }),
          ),
        ).toHaveProperty("structuredContent.id", "it_1");
        expect({}).not.toHaveProperty("polluted");
      }),
  );
  it.live("maps parameters and preserves the entire API response", () =>
    Effect.gen(function* () {
      const { session, requests } = yield* makeFixture;
      const result = yield* Effect.tryPromise(() =>
        session.client.callTool({
          name: "list_items",
          arguments: { query: { limit: 5, after: null } },
        }),
      );
      expect(requests[0]).toMatchObject({
        method: "GET",
        headers: { "x-api-key": TEST_KEY },
      });
      expect(requests[0]?.url.pathname).toBe("/v1/items");
      expect(Object.fromEntries(requests[0]?.url.searchParams ?? [])).toEqual({
        limit: "5",
      });
      expect(result).toHaveProperty(
        "structuredContent.pagination.next_cursor",
        "it_3",
      );
      expect(result).toHaveProperty(
        "structuredContent.metadata.source",
        "inventory",
      );
      expect(JSON.stringify(result)).not.toContain(TEST_KEY);
    }),
  );
  it.live.each([
    [
      "create_item",
      "POST",
      { body: { label: "New", state: null } },
      "/v1/items",
    ],
    [
      "update_item",
      "PATCH",
      { path: { id: "it_1" }, body: { label: "Updated", state: "ACTIVE" } },
      "/v1/items/it_1",
    ],
    ["delete_item", "DELETE", { path: { id: "it_1" } }, "/v1/items/it_1"],
    ["search_items", "POST", { body: { term: "widget" } }, "/v1/search"],
  ] as const)(
    "executes %s from its generated schema",
    ([name, method, args, path]) =>
      Effect.gen(function* () {
        const { session, requests } = yield* makeFixture;
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({ name, arguments: args }),
          ),
        ).not.toHaveProperty("isError", true);
        expect(requests[0]).toMatchObject({
          method,
          body: "body" in args ? args.body : undefined,
          headers: { "x-api-key": TEST_KEY },
        });
        expect(requests[0]?.url.pathname).toBe(path);
      }),
  );
  it.live("filters tools from both discovery and invocation", () =>
    Effect.gen(function* () {
      const { useCatalog, baseUrl, requests } = yield* makeFixture;

      const session = yield* useCatalog(
        inventoryCatalog({ baseUrl, methods: ["get"] }),
      );
      expect(
        (yield* Effect.tryPromise(() => session.client.listTools())).tools,
      ).toHaveLength(2);
      const error = yield* Effect.tryPromise(() =>
        session.client.callTool({
          name: "create_item",
          arguments: { body: { label: "New", state: null } },
        }),
      ).pipe(Effect.flip);
      expect(error.cause).toHaveProperty(
        "message",
        expect.stringContaining("not found"),
      );
      expect(requests).toHaveLength(0);
    }),
  );
  it.live.each([
    ["get_item", {}],
    ["get_item", { path: { wrong: "it_1" } }],
    ["get_item", { path: { id: "wrong" } }],
    ["list_items", { query: { limit: 101 } }],
    ["list_items", { query: { limit: "5" } }],
    ["list_items", { query: { unknown: true } }],
    ["create_item", {}],
    ["create_item", { body: { label: "New", state: "INVALID" } }],
    ["get_item", { path: { id: "it_1" }, unknown: true }],
  ] as const)(
    "rejects invalid arguments to %s before HTTP execution",
    ([name, args]) =>
      Effect.gen(function* () {
        const { session, requests } = yield* makeFixture;
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({ name, arguments: args }),
          ),
        ).toHaveProperty("isError", true);
        expect(requests).toHaveLength(0);
      }),
  );
  it.live(
    "serializes arrays, false, zero, empty strings and headers by OpenAPI rules",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const session = yield* useCatalog(
          compileOpenApi(CODEC_SPEC, {
            baseUrl,
            credentials: TEST_CREDENTIALS,
          }),
        );
        yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "read_codec",
            arguments: {
              path: { id: "A/B ?#ü" },
              query: {
                tags: ["a&b", "c,d"],
                numbers: [0, 2],
                empty: "",
                optional: null,
                enabled: false,
              },
              headers: { "X-Trace": ["one", "two"] },
            },
          }),
        );
        expect(requests[0]?.url.pathname).toBe(
          "/v1/codec/A%2FB%20%3F%23%C3%BC",
        );
        expect(requests[0]?.url.searchParams.getAll("tags")).toEqual([
          "a&b",
          "c,d",
        ]);
        expect(requests[0]?.url.searchParams.get("numbers")).toBe("0,2");
        expect(requests[0]?.url.searchParams.get("empty")).toBe("");
        expect(requests[0]?.url.searchParams.has("optional")).toBe(false);
        expect(requests[0]?.url.searchParams.get("enabled")).toBe("false");
        expect(requests[0]?.headers["x-trace"]).toBe("one,two");
      }),
  );
  it.live(
    "rejects path traversal after validation without contacting the API",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const session = yield* useCatalog(
          compileOpenApi(CODEC_SPEC, {
            baseUrl,
            credentials: TEST_CREDENTIALS,
          }),
        );
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({
              name: "read_codec",
              arguments: { path: { id: ".." } },
            }),
          ),
        ).toHaveProperty("isError", true);
        expect(requests).toHaveLength(0);
      }),
  );
  it.live.each(["a string", [1, 2], null])(
    "encodes a whole-body %j value",
    (body) =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const session = yield* useCatalog(
          compileOpenApi(CODEC_SPEC, {
            baseUrl,
            credentials: TEST_CREDENTIALS,
          }),
        );
        yield* Effect.tryPromise(() =>
          session.client.callTool({ name: "write_json", arguments: { body } }),
        );
        expect(requests[0]).toMatchObject({
          body,
          headers: { "content-type": "application/problem+json" },
        });
      }),
  );
  it.live(
    "executes deepObject and delimited queries through the independent MCP client",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const session = yield* useCatalog(
          compileOpenApi(
            {
              openapi: "3.2.1",
              paths: {
                "/search": {
                  get: {
                    operationId: "styled_search",
                    parameters: [
                      {
                        name: "filter",
                        in: "query",
                        style: "deepObject",
                        schema: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            city: { type: "string" },
                            enabled: { type: "boolean" },
                          },
                        },
                      },
                      {
                        name: "tags",
                        in: "query",
                        style: "pipeDelimited",
                        explode: false,
                        schema: { type: "array", items: { type: "string" } },
                      },
                    ],
                    responses: API_RESPONSES,
                  },
                },
              },
            },
            { baseUrl },
          ),
        );
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({
              name: "styled_search",
              arguments: {
                query: {
                  filter: { city: "A+B & é", enabled: false },
                  tags: ["x,y", "z"],
                },
              },
            }),
          ),
        ).toHaveProperty("structuredContent.id", "it_1");
        expect(requests[0]?.url.search).toBe(
          "?filter%5Bcity%5D=A%2BB%20%26%20%C3%A9&filter%5Benabled%5D=false&tags=x%2Cy%7Cz",
        );
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({
              name: "styled_search",
              arguments: { query: { filter: { city: { nested: "value" } } } },
            }),
          ),
        ).toHaveProperty("isError", true);
        expect(requests).toHaveLength(1);
      }),
  );
  it.live(
    "calls a generated form tool through the independent MCP client",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const session = yield* useCatalog(
          compileOpenApi(
            {
              openapi: "3.2.1",
              paths: {
                "/forms": {
                  post: {
                    operationId: "submit_form",
                    requestBody: {
                      required: true,
                      content: {
                        "application/x-www-form-urlencoded": {
                          schema: {
                            type: "object",
                            additionalProperties: false,
                            required: ["name"],
                            properties: {
                              name: { type: "string", minLength: 1 },
                              tags: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                          },
                        },
                      },
                    },
                    responses: API_RESPONSES,
                  },
                },
              },
            },
            { baseUrl },
          ),
        );
        expect(
          (yield* Effect.tryPromise(() => session.client.listTools())).tools[0]
            ?.inputSchema,
        ).toHaveProperty("properties.body.required", ["name"]);
        const result = yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "submit_form",
            arguments: {
              body: { name: "A+B & é", tags: ["one two", "three"] },
            },
          }),
        );
        expect(result).toHaveProperty("structuredContent.id", "it_1");
        expect(requests[0]).toMatchObject({
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          rawBody: "name=A%2BB+%26+%C3%A9&tags=one+two&tags=three",
        });
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({
              name: "submit_form",
              arguments: { body: { name: "" } },
            }),
          ),
        ).toHaveProperty("isError", true);
        expect(requests).toHaveLength(1);
      }),
  );
  it.live(
    "executes PUT and handles content-free HEAD and DELETE responses",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests, replies } = yield* makeFixture;

        let session = yield* useCatalog(
          compileOpenApi(CODEC_SPEC, {
            baseUrl,
            credentials: TEST_CREDENTIALS,
          }),
        );
        yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "replace",
            arguments: { body: { value: 1 } },
          }),
        );
        expect(requests[0]).toMatchObject({
          method: "PUT",
          body: { value: 1 },
        });
        replies.set("/v1/health", { raw: "" });
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({ name: "health", arguments: {} }),
          ),
        ).toHaveProperty("structuredContent.result", null);
        session = yield* useCatalog(inventoryCatalog({ baseUrl }));
        replies.set("/v1/items/it_1", { status: 204, raw: "" });
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({
              name: "delete_item",
              arguments: { path: { id: "it_1" } },
            }),
          ),
        ).toHaveProperty("structuredContent.result", null);
      }),
  );
  it.live.each([
    ["a string", { result: "a string" }],
    [[1, 2], { result: [1, 2] }],
    [null, { result: null }],
  ] as const)(
    "wraps non-object API responses consistently",
    ([body, expected]) =>
      Effect.gen(function* () {
        const { replies, session } = yield* makeFixture;
        replies.set("/v1/items/it_1", { body });
        const result = yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "get_item",
            arguments: { path: { id: "it_1" } },
          }),
        );
        expect(result).toHaveProperty("structuredContent", expected);
        expect(result).toHaveProperty(
          "content.0.text",
          JSON.stringify(expected),
        );
      }),
  );
  it.live("uses an unrelated bearer API without changing the adapter", () =>
    Effect.gen(function* () {
      const { useCatalog, baseUrl, requests } = yield* makeFixture;

      const session = yield* useCatalog(
        compileOpenApi(TICKETING_SPEC, {
          baseUrl,
          credentials: { AccessToken: Redacted.make("private-ticket-token") },
        }),
      );
      yield* Effect.tryPromise(() =>
        session.client.callTool({
          name: "get_ticket",
          arguments: { path: { number: 42 } },
        }),
      );
      expect(requests[0]).toMatchObject({
        method: "GET",
        headers: { authorization: "Bearer private-ticket-token" },
      });
      expect(requests[0]?.url.pathname).toBe("/v1/tickets/42");
      expect(requests[0]?.headers["x-api-key"]).toBeUndefined();
    }),
  );
  it.live(
    "injects query credentials and honors anonymous security overrides",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const spec = {
          openapi: "3.1.0",
          security: [{ QueryKey: [] }],
          components: {
            securitySchemes: {
              QueryKey: { type: "apiKey", in: "query", name: "api_key" },
            },
          },
          paths: {
            "/private": {
              get: {
                parameters: [
                  { in: "query", name: "api_key", schema: { type: "string" } },
                ],
                responses: API_RESPONSES,
              },
            },
            "/public": { get: { security: [], responses: API_RESPONSES } },
          },
        };
        const session = yield* useCatalog(
          compileOpenApi(spec, {
            baseUrl,
            credentials: { QueryKey: Redacted.make(TEST_KEY) },
          }),
        );
        expect(
          JSON.stringify(
            (yield* Effect.tryPromise(() => session.client.listTools())).tools,
          ),
        ).not.toContain(TEST_KEY);
        yield* Effect.tryPromise(() =>
          session.client.callTool({ name: "get_private", arguments: {} }),
        );
        expect(requests[0]?.url.searchParams.get("api_key")).toBe(TEST_KEY);
        yield* Effect.tryPromise(() =>
          session.client.callTool({ name: "get_public", arguments: {} }),
        );
        expect(requests[1]?.url.searchParams.has("api_key")).toBe(false);
      }),
  );
  const failureReplies: ReadonlyArray<Reply> = [
    { raw: "not JSON" },
    { raw: "" },
    { headers: { "Content-Type": "text/html" }, raw: "private response" },
    { status: 401, body: { error: TEST_KEY } },
    { status: 403, body: { error: TEST_KEY } },
    { status: 404, body: { error: TEST_KEY } },
    { status: 429, body: { error: TEST_KEY } },
    {
      status: 307,
      headers: { Location: "https://other.example.com/" },
      body: {},
    },
  ];
  it.live.each(failureReplies)(
    "returns safe generic errors and rejects redirects",
    (reply) =>
      Effect.gen(function* () {
        const { replies, session, requests } = yield* makeFixture;
        replies.set("/v1/items/it_1", reply);
        const result = yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "get_item",
            arguments: { path: { id: "it_1" } },
          }),
        );
        expect(result).toHaveProperty("isError", true);
        expect(JSON.stringify(result)).not.toContain(TEST_KEY);
        expect(JSON.stringify(result)).not.toContain("private response");
        expect(requests).toHaveLength(1);
      }),
  );
  it.live("aborts the API request when the MCP caller cancels", () =>
    Effect.gen(function* () {
      const { replies, session, requests, abortedPaths } = yield* makeFixture;
      replies.set("/v1/items/it_1", { hang: true });
      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- Exercise cancellation initiated by the external MCP client, independently of Effect interruption.
      const controller = new AbortController();
      const cancelled = yield* Effect.tryPromise(() =>
        session.client.callTool(
          { name: "get_item", arguments: { path: { id: "it_1" } } },
          { signal: controller.signal },
        ),
      ).pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.tryPromise(() =>
        expect.poll(() => requests.length).toBe(1),
      );
      controller.abort();
      const error = yield* Fiber.join(cancelled);
      expect(error.cause).toBeInstanceOf(Error);
      yield* Effect.tryPromise(() =>
        expect.poll(() => abortedPaths).toEqual(["/v1/items/it_1"]),
      );
    }),
  );
  it.live.each([{ hang: true }, { hangBody: true }])(
    "times out and aborts stalled API work",
    (reply) =>
      Effect.gen(function* () {
        const { replies, session, abortedPaths } = yield* makeFixture;
        replies.set("/v1/items/it_1", reply);
        const result = yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "get_item",
            arguments: { path: { id: "it_1" } },
          }),
        );
        expect(result).toHaveProperty("isError", true);
        expect(JSON.stringify(result)).toContain("timed out");
        yield* Effect.tryPromise(() =>
          expect.poll(() => abortedPaths).toEqual(["/v1/items/it_1"]),
        );
      }),
  );
  it.live(
    "releases an active API call and listener when its scope closes",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, replies, requests, abortedPaths } =
          yield* makeFixture;

        const session = yield* useCatalog(
          inventoryCatalog({ baseUrl }),
          60_000,
        );
        replies.set("/v1/items/it_1", { hang: true });
        const disconnected = yield* Effect.tryPromise((signal) =>
          session.client.callTool(
            { name: "get_item", arguments: { path: { id: "it_1" } } },
            { signal },
          ),
        ).pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.tryPromise(() =>
          expect.poll(() => requests.length).toBe(1),
        );
        yield* session.server.close;
        const error = yield* Fiber.join(disconnected);
        expect(error.cause).toBeInstanceOf(Error);
        yield* Effect.tryPromise(() =>
          expect.poll(() => abortedPaths).toEqual(["/v1/items/it_1"]),
        );
        const connectionError = yield* Effect.tryPromise((signal) =>
          fetch(session.endpoint, { signal }),
        ).pipe(Effect.flip);
        expect(connectionError.cause).toBeInstanceOf(TypeError);
      }),
  );
  it.live("loads a remote spec and resolves its relative API URL", () =>
    Effect.gen(function* () {
      const { replies, baseUrl, useCatalog, requests } = yield* makeFixture;

      const spec = {
        openapi: "3.1.0",
        servers: [{ url: "/v2" }],
        paths: { "/widgets": { get: { responses: API_RESPONSES } } },
      };
      replies.set("/spec.json", { body: spec });
      const next = yield* loadOperationCatalog(
        new URL("/spec.json", baseUrl).href,
      ).pipe(Effect.provide([NodeFileSystem.layer, FetchHttpClient.layer]));
      const session = yield* useCatalog(next);
      yield* Effect.tryPromise(() =>
        session.client.callTool({ name: "get_widgets", arguments: {} }),
      );
      expect(requests[1]?.url.pathname).toBe("/v2/widgets");
    }),
  );
  it.live.each([
    { Host: "external.example.com" },
    { Origin: "https://external.example.com" },
  ])("rejects non-local hosts and origins", (headers) =>
    Effect.gen(function* () {
      const { session, requests } = yield* makeFixture;
      const status = yield* Effect.tryPromise(
        () =>
          new Promise<number | undefined>((resolve, reject) => {
            const request = httpRequest(
              session.endpoint,
              { method: "POST", headers },
              (response) => {
                response.resume();
                resolve(response.statusCode);
              },
            );
            request.once("error", reject);
            request.end();
          }),
      );
      expect(status).toBe(403);
      expect(requests).toHaveLength(0);
    }),
  );
  it.live("accepts the local origin and returns 404 for unrelated routes", () =>
    Effect.gen(function* () {
      const { session } = yield* makeFixture;
      expect(
        (yield* Effect.tryPromise(() =>
          fetch(session.endpoint, {
            method: "OPTIONS",
            headers: { Origin: session.endpoint.origin },
          }),
        )).status,
      ).toBe(405);
      expect(
        (yield* Effect.tryPromise(() =>
          fetch(new URL("/other", session.endpoint)),
        )).status,
      ).toBe(404);
    }),
  );
  it.live.each(["github-3.0.json.gz", "github-3.1.json.gz"] as const)(
    "executes a pinned public %s operation over MCP",
    (file) =>
      Effect.gen(function* () {
        const { baseUrl, useCatalog, requests } = yield* makeFixture;

        const next = compileOpenApi(readPublicSpec(file).document, {
          baseUrl,
          methods: ["get"],
        });
        const session = yield* useCatalog(next);
        const operation = next.operations.find(
          (operation) => operation.path === "/repos/{owner}/{repo}",
        );
        if (operation === undefined) {
          throw new Error("Missing public fixture operation.");
        }
        const result = yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: operation.name,
            arguments: { path: { owner: "octo owner", repo: "project" } },
          }),
        );
        expect(result).not.toHaveProperty("isError", true);
        expect(requests[0]?.url.pathname).toBe(
          "/v1/repos/octo%20owner/project",
        );
        expect(requests[0]?.headers.accept).toBe("application/json");
        expect(result).toHaveProperty(
          "structuredContent.pagination.next_cursor",
          "it_3",
        );
      }),
    30_000,
  );
  it.live.each(["3.2.0", "3.2.1"])(
    "executes the official QUERY example through MCP in OpenAPI %s",
    (openapi) =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const spec = {
          ...readPublicSpec("oai-query-3.2.yaml").document,
          openapi,
        };
        const session = yield* useCatalog(compileOpenApi(spec, { baseUrl }));
        const tools = yield* Effect.tryPromise(() =>
          session.client.listTools(),
        );
        expect(tools.tools[0]?.annotations).toMatchObject({
          readOnlyHint: true,
          idempotentHint: true,
          destructiveHint: false,
        });
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({
              name: "searchFlights",
              arguments: {
                body: {
                  origin: "ATL",
                  destination: "LHR",
                  departureDate: "2026-06-15",
                  passengers: 0,
                },
              },
            }),
          ),
        ).toHaveProperty("isError", true);
        expect(requests).toHaveLength(0);
        const body = {
          origin: "ATL",
          destination: "LHR",
          departureDate: "2026-06-15",
          passengers: 2,
          cabinClass: "business",
        };
        const result = yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "searchFlights",
            arguments: { body },
          }),
        );
        expect(result).not.toHaveProperty("isError", true);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: "QUERY", body });
        expect(requests[0]?.url.pathname).toBe("/v1/flights/search");
        expect(requests[0]?.headers).toMatchObject({
          accept: "application/json",
          "content-type": "application/json",
        });
      }),
  );
  it.live(
    "executes reusable 3.2 media types with fragment-form authentication",
    () =>
      Effect.gen(function* () {
        const { baseUrl, useCatalog, requests } = yield* makeFixture;

        const reference = "#/components/securitySchemes/Token";
        const next = compileOpenApi(
          {
            openapi: "3.2.1",
            security: [{ [reference]: [] }],
            components: {
              securitySchemes: { Token: { type: "http", scheme: "bearer" } },
              mediaTypes: {
                Payload: { schema: { type: "integer", minimum: 1 } },
              },
            },
            paths: {
              "/values": {
                query: {
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": {
                        $ref: "#/components/mediaTypes/Payload",
                      },
                    },
                  },
                  responses: {
                    "200": {
                      content: {
                        "application/json": {
                          $ref: "#/components/mediaTypes/Payload",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          { baseUrl, credentials: { [reference]: Redacted.make(TEST_KEY) } },
        );
        const session = yield* useCatalog(next);
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({
              name: "query_values",
              arguments: { body: 0 },
            }),
          ),
        ).toHaveProperty("isError", true);
        expect(requests).toHaveLength(0);
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({
              name: "query_values",
              arguments: { body: 1 },
            }),
          ),
        ).not.toHaveProperty("isError", true);
        expect(requests[0]).toMatchObject({ method: "QUERY", body: 1 });
        expect(requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
        expect(
          JSON.stringify(
            yield* Effect.tryPromise(() => session.client.listTools()),
          ),
        ).not.toContain(TEST_KEY);
      }),
  );
  it.live(
    "executes a 3.2 operation without declared responses using JSON negotiation",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const session = yield* useCatalog(
          compileOpenApi(readPublicSpec("oai-tags-3.2.yaml").document, {
            baseUrl,
          }),
        );
        const result = yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "get_flights",
            arguments: {},
          }),
        );
        expect(result).toHaveProperty("structuredContent.id", "it_1");
        expect(requests[0]?.headers.accept).toBe("application/json");
        expect(requests[0]?.method).toBe("GET");
      }),
  );
  it.live(
    "negotiates JSON from mixed response types and sends an OAuth access token",
    () =>
      Effect.gen(function* () {
        const { baseUrl, useCatalog, requests } = yield* makeFixture;

        const next = compileOpenApi(
          readPublicSpec("petstore-3.0.yaml").document,
          {
            baseUrl,
            credentials: {
              petstore_auth: Redacted.make(TEST_KEY),
              api_key: Redacted.make("unused-key"),
            },
          },
        );
        const session = yield* useCatalog(next);
        const result = yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "findPetsByStatus",
            arguments: { query: { status: "available" } },
          }),
        );
        expect(result).not.toHaveProperty("isError", true);
        expect(requests[0]?.headers).toMatchObject({
          accept: "application/json",
          authorization: `Bearer ${TEST_KEY}`,
        });
        expect(requests[0]?.url.pathname).toBe("/v1/pet/findByStatus");
        expect(
          JSON.stringify(
            (yield* Effect.tryPromise(() => session.client.listTools())).tools,
          ),
        ).not.toContain(TEST_KEY);
      }),
  );
  it.live(
    "preserves comma delimiters separately from escaped query values",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const spec = {
          openapi: "3.1.0",
          paths: {
            "/values": {
              get: {
                parameters: [
                  {
                    in: "query",
                    name: "values",
                    explode: false,
                    schema: { type: "array", items: { type: "string" } },
                  },
                ],
                responses: API_RESPONSES,
              },
            },
          },
        };
        const session = yield* useCatalog(compileOpenApi(spec, { baseUrl }));
        yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "get_values",
            arguments: { query: { values: ["a,b", "c d", "x&y"] } },
          }),
        );
        expect(requests[0]?.url.search).toBe("?values=a%2Cb,c%20d,x%26y");
      }),
  );
  it.live("uses declared vendor response types in Accept", () =>
    Effect.gen(function* () {
      const { useCatalog, baseUrl, replies, requests } = yield* makeFixture;

      const spec = {
        openapi: "3.1.0",
        paths: {
          "/values": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/vnd.example+json": {},
                    "application/xml": {},
                  },
                },
              },
            },
          },
        },
      };
      const session = yield* useCatalog(compileOpenApi(spec, { baseUrl }));
      replies.set("/v1/values", {
        headers: {
          "Content-Type": "Application/Vnd.Example+Json; charset=utf-8",
        },
        body: { value: 1 },
      });
      expect(
        yield* Effect.tryPromise(() =>
          session.client.callTool({ name: "get_values", arguments: {} }),
        ),
      ).toHaveProperty("structuredContent.value", 1);
      expect(requests[0]?.headers.accept).toBe("application/vnd.example+json");
    }),
  );
  it.live(
    "handles declared empty 200 responses and specific responses ahead of default",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, replies } = yield* makeFixture;

        const spec = {
          openapi: "3.1.0",
          paths: {
            "/empty": { get: { responses: { "200": {} } } },
            "/json": { get: { responses: { ...API_RESPONSES, default: {} } } },
          },
        };
        const session = yield* useCatalog(compileOpenApi(spec, { baseUrl }));
        replies.set("/v1/empty", {
          raw: "",
          headers: { "Content-Type": "text/plain" },
        });
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({ name: "get_empty", arguments: {} }),
          ),
        ).toHaveProperty("structuredContent.result", null);
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({ name: "get_json", arguments: {} }),
          ),
        ).toHaveProperty("structuredContent.id", "it_1");
      }),
  );
  it.live(
    "handles a success status range without preferring an empty default",
    () =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, replies } = yield* makeFixture;

        const spec = {
          openapi: "3.1.0",
          paths: {
            "/values": {
              get: {
                responses: {
                  "2XX": { content: { "application/json": {} } },
                  default: {},
                },
              },
            },
          },
        };
        const session = yield* useCatalog(compileOpenApi(spec, { baseUrl }));
        replies.set("/v1/values", { status: 202, body: { value: 2 } });
        expect(
          yield* Effect.tryPromise(() =>
            session.client.callTool({ name: "get_values", arguments: {} }),
          ),
        ).toHaveProperty("structuredContent.value", 2);
      }),
  );
  it.live.each(["ok\r\nX-Evil: yes", " padded ", "one,two"])(
    "rejects header injection or normalization before contacting the API: %s",
    (value) =>
      Effect.gen(function* () {
        const { useCatalog, baseUrl, requests } = yield* makeFixture;

        const session = yield* useCatalog(
          compileOpenApi(CODEC_SPEC, {
            baseUrl,
            credentials: TEST_CREDENTIALS,
          }),
        );
        const result = yield* Effect.tryPromise(() =>
          session.client.callTool({
            name: "read_codec",
            arguments: {
              path: { id: "safe" },
              headers: { "X-Trace": [value] },
            },
          }),
        );
        expect(result).toHaveProperty("isError", true);
        expect(requests).toHaveLength(0);
      }),
  );
});
