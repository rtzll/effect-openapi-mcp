import { request as httpRequest } from "node:http";
import { Context, Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { NetAddress } from "effect/net";
import { describe, expect, it } from "@effect/vitest";
import { HttpApi } from "./api-client.ts";
import { createMcpServer } from "./server.ts";
import { inventoryCatalog } from "./test-fixtures.ts";
import { generatedTools } from "./tools.ts";
import type { OperationArguments } from "./schema.ts";

const fixture = Effect.gen(function* () {
  const calls: OperationArguments[] = [];
  const tools = generatedTools(inventoryCatalog()).pipe(
    Layer.provide(
      Layer.succeed(HttpApi, {
        execute: (_operation, input) =>
          Effect.sync(() => {
            calls.push(input);
            return { updated: true };
          }),
      }),
    ),
  );
  const context = yield* Layer.build(
    createMcpServer(tools, { port: 0, logAddress: false }),
  );
  const server = Context.get(context, HttpServer.HttpServer);
  return {
    calls,
    endpoint: new URL("/mcp", NetAddress.formatUrlUnsafe(server.address)),
  };
});

const payload = (label: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "update_item",
      arguments: { path: { id: "it_1" }, body: { label, state: "ACTIVE" } },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {
          name: "encoding-test",
          version: "1",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });

const send = (
  endpoint: URL,
  chunks: readonly Uint8Array[],
  headers: Record<string, string | undefined> = {},
) =>
  Effect.callback<{ status: number | undefined; body: string }, Error>(
    (resume) => {
      const request = httpRequest(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Transfer-Encoding": "chunked",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": "update_item",
            ...headers,
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("error", (error) => resume(Effect.fail(error)));
          response.on("end", () =>
            resume(Effect.succeed({ status: response.statusCode, body })),
          );
        },
      );
      request.on("error", (error) => resume(Effect.fail(error)));
      let index = 0;
      const write = () => {
        const chunk = chunks[index++];
        if (request.destroyed) return;
        if (chunk === undefined) request.end();
        else request.write(chunk, () => setImmediate(write));
      };
      write();
      return Effect.sync(() => {
        request.destroy();
      });
    },
  );

describe("HTTP request UTF-8", () => {
  it.live.each([
    { bytes: [0xff] },
    { bytes: [0xc0, 0xaf] },
    { bytes: [0xed, 0xa0, 0x80] },
    { bytes: [0xe2, 0x82] },
  ])("rejects malformed bytes %j inside a mutation argument", ({ bytes }) =>
    Effect.gen(function* () {
      const { endpoint, calls } = yield* fixture;
      const [prefix, suffix] = payload("MARKER").split("MARKER");
      const response = yield* send(endpoint, [
        Buffer.from(prefix!),
        Uint8Array.from(bytes),
        Buffer.from(suffix!),
      ]);
      expect(response.status).toBe(200);
      expect(response.body).toContain('"code":-32700');
      expect(calls).toHaveLength(0);
    }),
  );

  it.live("rejects a truncated final UTF-8 sequence", () =>
    Effect.gen(function* () {
      const { endpoint, calls } = yield* fixture;
      const response = yield* send(endpoint, [
        Buffer.from(payload("safe")),
        Uint8Array.from([0xf0, 0x9f, 0x92]),
      ]);
      expect(response.status).toBe(200);
      expect(response.body).toContain('"code":-32700');
      expect(calls).toHaveLength(0);
    }),
  );

  it.live("preserves multibyte characters split across HTTP chunks", () =>
    Effect.gen(function* () {
      const { endpoint, calls } = yield* fixture;
      const label = "Grüße 💡";
      const bytes = Buffer.from(payload(label));
      const split = bytes.indexOf(Buffer.from("💡")) + 2;
      const response = yield* send(endpoint, [
        bytes.subarray(0, split),
        bytes.subarray(split, split + 1),
        bytes.subarray(split + 1),
      ]);
      expect(response.status).toBe(200);
      expect(response.body).toContain('"updated":true');
      expect(calls).toEqual([
        { path: { id: "it_1" }, body: { label, state: "ACTIVE" } },
      ]);
    }),
  );

  it.live.each([
    { headers: { "Content-Type": "text/plain" }, status: 415 },
    { headers: { Accept: "application/json" }, status: 406 },
  ])(
    "preserves header admission for invalid bodies: %j",
    ({ headers, status }) =>
      Effect.gen(function* () {
        const { endpoint, calls } = yield* fixture;
        const response = yield* send(
          endpoint,
          [Uint8Array.from([0xff])],
          headers,
        );
        expect(response.status).toBe(status);
        expect(calls).toHaveLength(0);
      }),
  );
});
