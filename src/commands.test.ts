import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Console, Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect, it } from "@effect/vitest";
import { runCommand } from "./commands.ts";
import { readBoundedText } from "./bounded-text.ts";
import { InspectionError } from "./inspection.ts";
import { SERVER_INFO } from "./package-info.ts";
import { INVENTORY_SPEC } from "./test-fixtures.ts";

const execute = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  environment: Record<string, string> = {},
) {
  const output: string[] = [];
  const errors: string[] = [];
  const console_: Console.Console = {
    ...console,
    log: (...values: ReadonlyArray<unknown>) => output.push(values.join(" ")),
    error: (...values: ReadonlyArray<unknown>) => errors.push(values.join(" ")),
  };
  const result = yield* runCommand(args).pipe(
    Effect.provideService(Console.Console, console_),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: environment,
          preserveEmptyStrings: true,
        }),
      ),
    ),
    Effect.result,
  );
  return { result, output: output.join("\n"), errors: errors.join("\n") };
});
const withSpec = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "openapi-mcp-command-",
  });
  const location = `${directory}/spec.json`;
  yield* fs.writeFileString(location, JSON.stringify(INVENTORY_SPEC));
  return {
    MCP_OPENAPI_SPEC: location,
    MCP_CREDENTIALS: '{"Key":"inspection-secret"}',
  };
});
const Report = Schema.fromJsonString(
  Schema.Struct({
    summary: Schema.Struct({
      exposed: Schema.Finite,
      filtered: Schema.Finite,
      unsupported: Schema.Finite,
    }),
    tools: Schema.Array(
      Schema.Struct({ name: Schema.String, inputSchema: Schema.JsonObject }),
    ),
    filtered: Schema.Array(Schema.JsonObject),
    unsupported: Schema.Array(Schema.JsonObject),
  }),
);

it.layer(NodeServices.layer)("Native Effect CLI commands", (it) => {
  it.effect.each([
    ["--help"],
    ["inspect", "--help"],
    ["check", "--help"],
    ["--version"],
  ])("handles %s without requiring configuration", (args) =>
    Effect.gen(function* () {
      const response = yield* execute(args);
      expect(response.result._tag).toBe("Success");
      expect(response.errors).toBe("");
      expect(response.output).toContain(
        args.includes("--version") ? SERVER_INFO.version : "effect-openapi-mcp",
      );
    }),
  );
  it.effect("exports a usable JSON report without leaking credentials", () =>
    Effect.gen(function* () {
      const response = yield* execute(["inspect", "--json"], yield* withSpec());
      expect(response.result._tag).toBe("Success");
      const report = yield* Schema.decodeEffect(Report)(response.output);
      expect(report.summary).toEqual({
        exposed: 6,
        filtered: 0,
        unsupported: 0,
      });
      expect(report.tools.map((tool) => tool.name)).toContain("get_item");
      expect(response.output).not.toContain("inspection-secret");
      expect(response.output).not.toContain("baseUrl");
    }),
  );
  it.effect(
    "applies the configured profile before exporting inspection metadata",
    () =>
      Effect.gen(function* () {
        const environment = yield* withSpec();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          environment.MCP_OPENAPI_SPEC,
          JSON.stringify({
            openapi: "3.2.1",
            servers: [{ url: "https://api.example.com" }],
            paths: {
              "/search": {
                get: {
                  operationId: "search",
                  parameters: [
                    {
                      name: "filter",
                      in: "query",
                      style: "deepObject",
                      schema: {
                        type: "array",
                        items: { type: "integer", minimum: 1 },
                      },
                    },
                  ],
                },
              },
            },
          }),
        );
        const response = yield* execute(["inspect", "--json"], {
          ...environment,
          MCP_PARAMETER_PROFILE: "brackets-indexed",
        });
        expect(response.result._tag).toBe("Success");
        const report = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.JsonObject),
        )(response.output);
        expect(report).toHaveProperty("summary.exposed", 1);
        expect(report).toHaveProperty(
          "tools.0.serialization.parameters.0.encoding.profile",
          "brackets-indexed",
        );
        expect(response.output).not.toContain("inspection-secret");
      }),
  );
  it.effect(
    "reports intentional filters and allows inspect with zero tools",
    () =>
      Effect.gen(function* () {
        const environment = {
          ...(yield* withSpec()),
          MCP_TAGS: '["does-not-exist"]',
        };
        const response = yield* execute(["inspect", "--json"], environment);
        expect(response.result._tag).toBe("Success");
        const report = yield* Schema.decodeEffect(Report)(response.output);
        expect(report.summary).toEqual({
          exposed: 0,
          filtered: 6,
          unsupported: 0,
        });
        const checked = yield* execute(["check", "--json"], environment);
        expect(checked.result._tag).toBe("Failure");
        if (checked.result._tag !== "Failure")
          throw new Error("Expected failure");
        expect(checked.result.failure).toBeInstanceOf(InspectionError);
        expect(checked.result.failure.message).toContain("6 filtered");
        expect(
          (yield* Schema.decodeEffect(Report)(checked.output)).summary.filtered,
        ).toBe(6);
      }),
  );
  it.effect(
    "strict checks reject unsupported operations while normal checks report them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const environment = yield* withSpec();
        yield* fs.writeFileString(
          environment.MCP_OPENAPI_SPEC,
          JSON.stringify({
            ...INVENTORY_SPEC,
            paths: {
              ...INVENTORY_SPEC.paths,
              "/unsupported": {
                get: {
                  responses: {
                    200: { content: { "application/jsonl": {} } },
                  },
                },
              },
            },
          }),
        );
        const normal = yield* execute(["check", "--json"], environment);
        expect(normal.result._tag).toBe("Success");
        expect(
          (yield* Schema.decodeEffect(Report)(normal.output)).summary
            .unsupported,
        ).toBe(1);
        const strict = yield* execute(
          ["check", "--strict", "--json"],
          environment,
        );
        expect(strict.result._tag).toBe("Failure");
        expect(
          (yield* Schema.decodeEffect(Report)(strict.output)).summary
            .unsupported,
        ).toBe(1);
      }),
  );
});

it.live(
  "the executable parses process arguments and exits without a spec or transport",
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const args of [
        ["--help"],
        ["--version"],
        ["inspect", "--unknown"],
      ]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args],
                { env: {}, extendEnv: false },
              ),
            );
            const result = yield* Effect.all(
              {
                stdout: readBoundedText(child.stdout, 1024 * 1024),
                stderr: readBoundedText(child.stderr, 1024 * 1024),
                code: child.exitCode,
              },
              { concurrency: "unbounded" },
            );
            expect(result.code === 0).toBe(!args.includes("--unknown"));
            expect(result.stdout).toContain(
              args.includes("--version")
                ? SERVER_INFO.version
                : SERVER_INFO.name,
            );
            expect(result.stderr).not.toContain("MCP_OPENAPI_SPEC");
          }).pipe(Effect.timeout("10 seconds")),
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  15_000,
);
