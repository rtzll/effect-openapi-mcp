import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createClientConfig } from "../scripts/client-config-program.ts";

const Config = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Struct({
      "openapi-fixture": Schema.Struct({
        type: Schema.Literal("stdio"),
        command: Schema.String,
        args: Schema.Array(Schema.String),
      }),
    }),
  }),
);

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "Client configuration generator",
  (it) => {
    it.effect(
      "prints only JSON with absolute checkout paths from any cwd",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const cwd = yield* fs.makeTempDirectoryScoped({
              prefix: "config unrelated cwd ",
            });
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const child = yield* spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [
                  fileURLToPath(
                    new URL("../scripts/client-config.ts", import.meta.url),
                  ),
                ],
                { cwd },
              ),
            );
            const [output, errors, code] = yield* Effect.all(
              [
                child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            expect(code).toBe(0);
            expect(errors).toBe("");
            const config = yield* Schema.decodeEffect(Config)(output);
            expect(config.mcpServers["openapi-fixture"]).toEqual({
              type: "stdio",
              command: process.execPath,
              args: [
                fileURLToPath(
                  new URL("../examples/client-fixture.ts", import.meta.url),
                ),
              ],
            });
            expect(output).toBe(JSON.stringify(config, null, 2) + "\n");
            expect(yield* fs.readDirectory(cwd)).toEqual([]);
          }).pipe(Effect.timeout("10 seconds")),
        ),
    );

    it.effect(
      "launches the generated configuration with spaces in its fixture path",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "client config spaces ",
          });
          const server = join(directory, "fixture with spaces.ts");
          const checkout = fileURLToPath(new URL("../", import.meta.url));
          yield* fs.copyFile(
            join(checkout, "examples/client-fixture.ts"),
            server,
          );
          // Keep the copied TypeScript outside node_modules while retaining the
          // fixture's public self-reference and the checkout's dependencies.
          yield* fs.writeFileString(
            join(directory, "package.json"),
            JSON.stringify({
              name: "effect-openapi-mcp",
              type: "module",
              exports: { ".": "./dist/index.js" },
            }),
          );
          yield* fs.symlink(join(checkout, "dist"), join(directory, "dist"));
          yield* fs.symlink(
            join(checkout, "node_modules"),
            join(directory, "node_modules"),
          );
          const config = yield* createClientConfig(process.execPath, server);
          const decoded = yield* Schema.decodeEffect(Config)(
            JSON.stringify(config),
          );
          expect(decoded.mcpServers["openapi-fixture"].args).toEqual([server]);
          const transport = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new StdioClientTransport({
                  ...decoded.mcpServers["openapi-fixture"],
                  args: [...decoded.mcpServers["openapi-fixture"].args],
                  cwd: checkout,
                  stderr: "pipe",
                }),
            ),
            (resource) =>
              Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
          );
          transport.stderr?.on("data", () => {});
          const client = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Client(
                  { name: "config-launch-test", version: "1.0.0" },
                  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
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
          const echoed = yield* Effect.tryPromise(() =>
            client.callTool({
              name: "echo_message",
              arguments: { query: { message: "config + spaces 😀", count: 3 } },
            }),
          );
          expect(echoed.structuredContent).toEqual({
            message: "config + spaces 😀",
            count: 3,
          });
        }),
    );

    it.effect("rejects missing files, directories and relative paths", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        for (const [node, server, message] of [
          ["node", directory, "Node executable path must be absolute."],
          [process.execPath, "fixture.ts", "Fixture path must be absolute."],
          [directory, directory, "Node executable path must name a file."],
          [process.execPath, directory, "Fixture path must name a file."],
          [
            process.execPath,
            join(directory, "absent.ts"),
            "Fixture file is unavailable:",
          ],
        ]) {
          const result = yield* createClientConfig(node, server).pipe(
            Effect.result,
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure.message).toContain(message);
          }
        }
      }),
    );
  },
);
