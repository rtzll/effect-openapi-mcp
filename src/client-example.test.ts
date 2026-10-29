import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

it.live.each(["2026-07-28", "2025-11-25"] as const)(
  "runs the offline client fixture through stdio (%s)",
  (version) =>
    Effect.gen(function* () {
      const transport = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new StdioClientTransport({
              command: process.execPath,
              args: [
                fileURLToPath(
                  new URL("../examples/client-fixture.ts", import.meta.url),
                ),
              ],
              stderr: "pipe",
            }),
        ),
        (resource) =>
          Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
      );
      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Client(
              { name: "offline-example-test", version: "1.0.0" },
              {
                versionNegotiation: {
                  mode: version === "2025-11-25" ? "legacy" : { pin: version },
                },
              },
            ),
        ),
        (resource) =>
          Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
      );
      yield* Effect.tryPromise(() => client.connect(transport));
      const listing = yield* Effect.tryPromise(() => client.listTools());
      expect(listing.tools.map((tool) => tool.name)).toEqual([
        "echo_message",
        "echo_text",
      ]);
      expect(
        listing.tools.every((tool) => tool.annotations?.readOnlyHint),
      ).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          client.callTool({
            name: "echo_message",
            arguments: { query: { message: "Café + 😀", count: 3 } },
          }),
        ),
      ).toHaveProperty("structuredContent", {
        message: "Café + 😀",
        count: 3,
      });
      expect(
        yield* Effect.tryPromise(() =>
          client.callTool({
            name: "echo_text",
            arguments: { body: "\uFEFFé\r\n😀" },
          }),
        ),
      ).toHaveProperty("structuredContent.result", "\uFEFFé\r\n😀");
      expect(
        yield* Effect.tryPromise(() =>
          client.callTool({
            name: "echo_message",
            arguments: { query: { message: "a", count: 11 } },
          }),
        ),
      ).toHaveProperty("isError", true);
    }),
  15_000,
);
