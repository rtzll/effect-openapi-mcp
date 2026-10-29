import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  loadProfile,
  profileMetadata,
  type Profile,
} from "../examples/client-evaluation/profiles.ts";

const connect = (profile: Profile) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "mcp-evaluation-test-"))),
      (path) =>
        Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    );
    const journal = join(directory, "dispatch.jsonl");
    const transport = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL(
                  "../examples/client-evaluation/server.ts",
                  import.meta.url,
                ),
              ),
              profile,
            ],
            env: { EVALUATION_JOURNAL: journal },
            stderr: "pipe",
          }),
      ),
      (resource) =>
        Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
    );
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Client({ name: "evaluation-fixture-sdk-test", version: "1.0.0" }),
      ),
      (resource) =>
        Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
    );
    yield* Effect.tryPromise(() => client.connect(transport));
    const events = () => {
      try {
        return readFileSync(journal, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; tool: string });
      } catch {
        return [];
      }
    };
    return { client, events };
  });

it.live(
  "echo preserves Unicode and rejects invalid SDK calls before dispatch",
  () =>
    Effect.gen(function* () {
      const { client, events } = yield* connect("echo");
      const tools = yield* Effect.tryPromise(() => client.listTools());
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "echo_message",
        "echo_text",
      ]);
      for (const args of [
        { query: { message: "x", count: 11 } },
        { query: { count: 3 } },
        { query: { message: "x", count: 3 }, extra: true },
      ]) {
        expect(
          yield* Effect.tryPromise(() =>
            client.callTool({ name: "echo_message", arguments: args }),
          ),
        ).toHaveProperty("isError", true);
      }
      expect(
        yield* Effect.tryPromise(() =>
          client.callTool({ name: "echo_text", arguments: { body: 1 } }),
        ),
      ).toHaveProperty("isError", true);
      expect(events()).toEqual([]);
      expect(
        yield* Effect.tryPromise(() =>
          client.callTool({
            name: "echo_text",
            arguments: { body: "\uFEFFé\r\n😀" },
          }),
        ),
      ).toHaveProperty("structuredContent.result", "\uFEFFé\r\n😀");
      expect(
        events().filter((event) => event.event === "dispatch"),
      ).toHaveLength(1);
    }),
  20_000,
);

it.live(
  "inventory mutations affect only disposable state and errors remain sanitized",
  () =>
    Effect.gen(function* () {
      const { client, events } = yield* connect("inventory");
      const call = (name: string, arguments_: Record<string, unknown>) =>
        Effect.tryPromise(() =>
          client.callTool({ name, arguments: arguments_ }),
        );
      expect(
        (yield* Effect.tryPromise(() => client.listTools())).tools,
      ).toHaveLength(8);
      expect(
        yield* call("create_item", {
          body: { label: "Dummy created", state: "ACTIVE" },
        }),
      ).toHaveProperty("structuredContent.id", "it_3");
      expect(
        yield* call("update_item", {
          path: { id: "it_3" },
          body: { label: "Updated", state: "ARCHIVED" },
        }),
      ).toHaveProperty("structuredContent.label", "Updated");
      expect(yield* call("get_item", { path: { id: "it_3" } })).toHaveProperty(
        "structuredContent.state",
        "ARCHIVED",
      );
      expect(
        yield* call("delete_item", { path: { id: "it_3" } }),
      ).toHaveProperty("structuredContent.result", null);
      const missing = yield* call("get_item", { path: { id: "it_3" } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).not.toContain("DO_NOT_EXPOSE");
      const failure = yield* call("inventory_unavailable", {});
      expect(failure.isError).toBe(true);
      expect(JSON.stringify(failure)).not.toContain("DO_NOT_EXPOSE");
      expect(
        events().filter((event) => event.event === "dispatch"),
      ).toHaveLength(6);
      const fresh = yield* connect("inventory");
      expect(
        yield* Effect.tryPromise(() =>
          fresh.client.callTool({
            name: "get_item",
            arguments: { path: { id: "it_1" } },
          }),
        ),
      ).toHaveProperty("structuredContent.label", "Café + 😀");
      expect(
        (yield* Effect.tryPromise(() =>
          fresh.client.callTool({
            name: "get_item",
            arguments: { path: { id: "it_3" } },
          }),
        )).isError,
      ).toBe(true);
    }),
  25_000,
);

it.live.each(["cloudflare-full", "cloudflare-filtered"] as const)(
  "%s is pinned, discoverable, and any chosen operation uses the mock",
  (profile) =>
    Effect.gen(function* () {
      const metadata = yield* profileMetadata(profile);
      expect(metadata.sourceHash).toBe(
        "6d665f1f96baa87c5ba7bfc5ded9401d743a14af74250f594bd302ef4f1c71e8",
      );
      const { client, events } = yield* connect(profile);
      const tools = yield* Effect.tryPromise(() => client.listTools());
      expect(tools.tools).toHaveLength(metadata.toolCount);
      expect(
        yield* Effect.tryPromise(() =>
          client.callTool({
            name: "zones-get",
            arguments: { query: { name: "example.test" } },
          }),
        ),
      ).toHaveProperty("structuredContent.result.0.name", "example.test");
      if (profile === "cloudflare-full") {
        const other = loadProfile(profile).catalog.operations.find(
          (operation) =>
            operation.method === "get" &&
            operation.name !== "zones-get" &&
            operation.name !== "dns-records-for-a-zone-list-dns-records" &&
            operation.parameters.length === 0,
        );
        expect(other).toBeDefined();
        expect(
          yield* Effect.tryPromise(() =>
            client.callTool({ name: other!.name, arguments: {} }),
          ),
        ).toHaveProperty("structuredContent.mock", true);
      }
      expect(
        events().filter((event) => event.event === "dispatch").length,
      ).toBe(profile === "cloudflare-full" ? 2 : 1);
    }),
  30_000,
);

it.live(
  "SDK cancellation interrupts the local slow mock fiber",
  () =>
    Effect.gen(function* () {
      const { client, events } = yield* connect("inventory");
      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- Exercise cancellation initiated by the external MCP client, independently of Effect interruption.
      const controller = new AbortController();
      const pending = client
        .callTool(
          { name: "inventory_slow", arguments: {} },
          { signal: controller.signal },
        )
        .then(
          () => "completed",
          () => "cancelled",
        );
      for (
        let attempt = 0;
        attempt < 100 && !events().some((event) => event.event === "dispatch");
        attempt++
      )
        yield* Effect.sleep("20 millis");
      expect(events().some((event) => event.event === "dispatch")).toBe(true);
      controller.abort("bounded SDK test cancellation");
      expect(yield* Effect.tryPromise(() => pending)).toBe("cancelled");
      for (
        let attempt = 0;
        attempt < 100 && !events().some((event) => event.event === "cancelled");
        attempt++
      )
        yield* Effect.sleep("20 millis");
      expect(events().some((event) => event.event === "cancelled")).toBe(true);
      expect(events().some((event) => event.event === "result")).toBe(false);
    }),
  20_000,
);
