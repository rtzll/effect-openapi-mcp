import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { McpServer } from "effect/ai";
import { HttpServer } from "effect/http";
import { NetAddress } from "effect/net";
import { HttpApi } from "./api-client.ts";
import { compileOpenApi } from "./openapi.ts";
import { createMcpServer } from "./server.ts";
import { generatedTools } from "./tools.ts";

const document = {
  openapi: "3.1.0",
  servers: [{ url: "https://unused.example.com" }],
  paths: {
    "/ready": {
      get: {
        operationId: "startup_ready",
        responses: { "200": { content: { "application/json": {} } } },
      },
    },
  },
};
const sourceUrl = (name: string) => new URL(name, import.meta.url).href;
const stdioProgram = `
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { McpServer } from "effect/ai";
import { createStdioMcpServer } from ${JSON.stringify(sourceUrl("./server.ts"))};
import { compileOpenApi } from ${JSON.stringify(sourceUrl("./openapi.ts"))};
import { generatedTools } from ${JSON.stringify(sourceUrl("./tools.ts"))};
import { HttpApi } from ${JSON.stringify(sourceUrl("./api-client.ts"))};
const catalog = compileOpenApi(${JSON.stringify(document)});
const tools = Layer.unwrap(Effect.gen(function* () {
  // Require the shared registry explicitly, then suspend registration until the
  // client has an opportunity to send its already-queued startup messages.
  yield* McpServer.McpServer;
  yield* Effect.sleep("500 millis");
  return generatedTools(catalog);
})).pipe(Layer.provide(Layer.succeed(HttpApi, {
  execute: () => Effect.succeed({ ready: true })
})));
NodeRuntime.runMain(Layer.launch(createStdioMcpServer(tools)).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true)
));
`;

const acquireClient = (version: "2026-07-28" | "2025-11-25") =>
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new Client(
          { name: "startup-order-test", version: "1.0.0" },
          {
            versionNegotiation: {
              mode: version === "2025-11-25" ? "legacy" : { pin: version },
            },
          },
        ),
    ),
    (client) => Effect.tryPromise(() => client.close()).pipe(Effect.orDie),
  );

const verify = Effect.fn(function* (client: Client) {
  expect(client.getServerCapabilities()?.tools).toBeDefined();
  const listing = yield* Effect.tryPromise(() => client.listTools());
  expect(listing.tools.map((tool) => tool.name)).toEqual(["startup_ready"]);
  const response = yield* Effect.tryPromise(() =>
    client.callTool({ name: "startup_ready", arguments: {} }),
  );
  expect(response.isError).not.toBe(true);
  expect(response.structuredContent).toEqual({ ready: true });
});

it.live.each(["2026-07-28", "2025-11-25"] as const)(
  "registers delayed tools before stdio discovery (%s)",
  (version) =>
    Effect.gen(function* () {
      const transport = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new StdioClientTransport({
              command: process.execPath,
              args: ["--input-type=module", "--eval", stdioProgram],
              cwd: fileURLToPath(new URL("../", import.meta.url)),
              stderr: "pipe",
            }),
        ),
        (resource) =>
          Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
      );
      const client = yield* acquireClient(version);
      yield* Effect.tryPromise(() => client.connect(transport));
      yield* verify(client);
    }),
  10_000,
);

it.live.each(["2026-07-28", "2025-11-25"] as const)(
  "registers delayed tools before HTTP discovery (%s)",
  (version) =>
    Effect.gen(function* () {
      const catalog = compileOpenApi(document);
      const tools = Layer.unwrap(
        Effect.gen(function* () {
          yield* McpServer.McpServer;
          yield* Effect.sleep("50 millis");
          return generatedTools(catalog);
        }),
      ).pipe(
        Layer.provide(
          Layer.succeed(HttpApi, {
            execute: () => Effect.succeed({ ready: true }),
          }),
        ),
      );
      const context = yield* Layer.build(
        createMcpServer(tools, { port: 0, logAddress: false }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      );
      const server = Context.get(context, HttpServer.HttpServer);
      const client = yield* acquireClient(version);
      yield* Effect.tryPromise(() =>
        client.connect(
          new StreamableHTTPClientTransport(
            new URL("/mcp", NetAddress.formatUrlUnsafe(server.address)),
          ),
        ),
      );
      yield* verify(client);
    }),
  10_000,
);
