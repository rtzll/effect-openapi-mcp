import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

describe("Standalone stdio CLI", () => {
  it.live.each([
    {
      version: "2026-07-28",
      spec: "./examples/inventory.openapi.json",
      count: 6,
      tool: "get_item",
    },
    {
      version: "2025-11-25",
      spec: "./examples/inventory.openapi.json",
      count: 6,
      tool: "get_item",
    },
    {
      version: "2026-07-28",
      spec: "./fixtures/oai-query-3.2.yaml",
      count: 1,
      tool: "searchFlights",
    },
    {
      version: "2025-11-25",
      spec: "./fixtures/oai-query-3.2.yaml",
      count: 1,
      tool: "searchFlights",
    },
  ] as const)(
    "supports $version with $spec without stdout logging",
    ({ version, spec, count, tool }) =>
      Effect.gen(function* () {
        const transport = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new StdioClientTransport({
                command: process.execPath,
                args: [fileURLToPath(new URL("./cli.ts", import.meta.url))],
                cwd: fileURLToPath(new URL("../", import.meta.url)),
                env: {
                  MCP_TRANSPORT: "stdio",
                  MCP_OPENAPI_SPEC: spec,
                  MCP_API_BASE_URL: "https://api.example.com",
                  MCP_CREDENTIALS: '{"Key":"private-cli-test-key"}',
                },
                stderr: "pipe",
              }),
          ),
          (resource) =>
            Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
        );
        let logs = "";
        transport.stderr?.on("data", (chunk: Buffer) => {
          logs += chunk.toString();
        });
        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Client(
                { name: "stdio-interop-test", version: "1.0.0" },
                {
                  versionNegotiation: {
                    mode:
                      version === "2025-11-25" ? "legacy" : { pin: version },
                  },
                },
              ),
          ),
          (resource) =>
            Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
        );
        yield* Effect.tryPromise(() => client.connect(transport));
        const tools = yield* Effect.tryPromise(() => client.listTools());
        expect(tools.tools).toHaveLength(count);
        expect(JSON.stringify(tools)).not.toContain("private-cli-test-key");
        expect(logs).toContain(`MCP tools: ${count}`);
        expect(logs).not.toContain("private-cli-test-key");
        const result = yield* Effect.tryPromise(() =>
          client.callTool({ name: tool, arguments: {} }),
        );
        expect(result).toHaveProperty("isError", true);
      }),
  );
});
