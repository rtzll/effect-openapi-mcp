import { NodeFileSystem } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Effect, Redacted, Schema } from "effect";
import { HttpServer } from "effect/http";
import { NetAddress } from "effect/net";
import { expect, it } from "@effect/vitest";
import { CORPUS, readFixture } from "../scripts/corpus.ts";
import { parseOpenApi } from "./catalog.ts";
import { compileOpenApi } from "./openapi.ts";
import { OPENAPI_SCHEMA } from "./openapi-types.ts";
import { testServerLayer } from "./test-fixtures.ts";

it.live(
  "discovers the full Cloudflare catalog with current and legacy clients",
  () =>
    Effect.gen(function* () {
      const source = CORPUS.find((source) => source.name === "Cloudflare");
      if (source === undefined) throw new Error("Missing Cloudflare fixture");
      const fixture = yield* readFixture(source).pipe(
        Effect.provide(NodeFileSystem.layer),
      );
      const document = yield* Schema.decodeUnknownEffect(OPENAPI_SCHEMA)(
        parseOpenApi(fixture.text),
      );
      const catalog = compileOpenApi(document, {
        baseUrl: new URL("https://unused.example.com/v1"),
        credentials: Object.fromEntries(
          Object.keys(document.components.securitySchemes).map((name) => [
            name,
            Redacted.make("large-catalog:user-token"),
          ]),
        ),
      });
      expect(catalog.operations).toHaveLength(3504);
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const endpoint = new URL(
          "/mcp",
          NetAddress.formatUrlUnsafe(server.address),
        );
        for (const version of ["2026-07-28", "2025-11-25"] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* Effect.acquireRelease(
                Effect.sync(
                  () =>
                    new Client(
                      { name: "large-catalog-test", version: "1.0.0" },
                      {
                        versionNegotiation: {
                          mode:
                            version === "2025-11-25"
                              ? "legacy"
                              : { pin: version },
                        },
                      },
                    ),
                ),
                (resource) =>
                  Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
              );
              yield* Effect.tryPromise(() =>
                client.connect(new StreamableHTTPClientTransport(endpoint)),
              );
              const listing = yield* Effect.tryPromise(() =>
                client.listTools(),
              );
              expect(listing.tools.map((tool) => tool.name)).toEqual(
                catalog.operations.map((operation) => operation.name),
              );
              expect(JSON.stringify(listing)).not.toContain(
                "large-catalog:user-token",
              );
              const required = listing.tools.find(
                (tool) =>
                  Array.isArray(tool.inputSchema.required) &&
                  tool.inputSchema.required.includes("path"),
              );
              if (required === undefined)
                throw new Error("Expected a tool with required path arguments");
              const failure = yield* Effect.tryPromise(() =>
                client.callTool({ name: required.name, arguments: {} }),
              );
              expect(failure.isError).toBe(true);
              const content = failure.content[0];
              if (content?.type !== "text")
                throw new Error("Expected a validation diagnostic");
              expect(content.text).toContain("Invalid parameters for tool");
            }),
          );
        }
      }).pipe(Effect.provide(testServerLayer(catalog)));
    }),
  30_000,
);
