import { homedir } from "node:os";
import {
  dirname,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Data, Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import PACKAGE from "../package.json" with { type: "json" };

class PackageSmokeError extends Data.TaggedError("PackageSmokeError")<{
  message: string;
}> {}
const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new PackageSmokeError({ message }));
const isWithin = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== "" && !isAbsolute(path) && path.split(sep)[0] !== "..";
};
const childEnvironment: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (
    value !== undefined &&
    !name.startsWith("MCP_") &&
    name !== "NODE_PATH" &&
    name !== "NODE_OPTIONS"
  ) {
    childEnvironment[name] = value;
  }
}
childEnvironment.PATH = [
  dirname(process.execPath),
  process.env.PATH ?? "",
].join(delimiter);
const protocolVersions = ["2026-07-28", "2025-11-25"] as const;
const exampleFiles = [
  "library.ts",
  "library-program.ts",
  "recovery.ts",
  "recovery-program.ts",
  "cancellation.ts",
  "cancellation-program.ts",
  "client-fixture.ts",
] as const;
type ProtocolVersion = (typeof protocolVersions)[number];
const withClient = <E>(
  version: ProtocolVersion,
  options: {
    command: string;
    args?: ReadonlyArray<string>;
    cwd: string;
    env?: Record<string, string>;
  },
  verify: (client: Client) => Effect.Effect<void, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new StdioClientTransport({
              ...options,
              args: options.args === undefined ? undefined : [...options.args],
              env: { ...childEnvironment, ...options.env },
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
              { name: "package-smoke", version: "1.0.0" },
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
      yield* verify(client);
      yield* check(
        !logs.includes("package-smoke-secret"),
        "Package logs exposed credentials.",
      );
    }).pipe(Effect.timeout("15 seconds")),
  );
const consumerTypes = `import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  compileOpenApi, HttpApi, makeApiClient,
  type CompileOptions, type OperationDescriptor,
} from "effect-openapi-mcp";

const options: CompileOptions = { parameterProfile: "brackets-indexed" };
// @ts-expect-error The installed public profile type must remain closed.
const invalidOptions: CompileOptions = { parameterProfile: "unknown" };
void invalidOptions;
const catalog = compileOpenApi({
  openapi: "3.2.1",
  servers: [{ url: "https://mock.example.com" }],
  paths: { "/health": { get: { responses: { "200": {} } } } },
}, options);
const operation: OperationDescriptor | undefined = catalog.operations[0];
if (operation === undefined) throw new Error("Missing operation");
const http = HttpClient.make((request) => Effect.succeed(
  HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
));
const Api = Layer.effect(HttpApi,
  Effect.map(HttpClient.HttpClient, (client) => makeApiClient(client)),
).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));
const program = Effect.gen(function* () {
  const api = yield* HttpApi;
  const input = yield* Schema.decodeUnknownEffect(operation.parametersSchema)({});
  return yield* api.execute(operation, input);
});
void Effect.runPromise(program.pipe(Effect.provide(Api)));
`;

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const [archive, mode] = args;
  if (
    archive === undefined ||
    archive.length === 0 ||
    archive.startsWith("--") ||
    args.length > 2 ||
    (mode !== undefined && mode !== "--online")
  ) {
    return yield* new PackageSmokeError({
      message:
        "Supply a package archive path, optionally followed by --online.",
    });
  }
  const online = mode === "--online";
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const temporary = yield* fs.makeTempDirectoryScoped({
    prefix: "openapi-mcp-package-",
  });
  const archivePath = yield* fs.realPath(archive);
  const names = yield* spawner.string(
    ChildProcess.make("tar", ["-tzf", archivePath], { env: childEnvironment }),
  );
  const entries = names.trim().split("\n");
  yield* check(
    entries.every(
      (entry) =>
        entry.startsWith("package/") && !entry.split("/").includes(".."),
    ),
    "Unexpected archive paths.",
  );
  for (const name of [
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/cli.js",
    ...exampleFiles.map((name) => `examples/${name}`),
    "examples/inventory.openapi.json",
    "LICENSE",
    "README.md",
  ]) {
    yield* check(
      entries.includes(`package/${name}`),
      `Missing packaged file: ${name}`,
    );
  }
  yield* check(
    !entries.some(
      (entry) =>
        /(?:node_modules|__snapshots__|\.test\.|\.env(?:$|\.))/.test(entry) ||
        /(?:^|\/)\.(?:git|pnpm-store)(?:\/|$)/.test(entry) ||
        entry.startsWith("package/examples/client-evaluation/") ||
        entry.startsWith("package/reports/") ||
        entry.startsWith("package/fixtures/"),
    ),
    "Development files or secrets in package archive.",
  );
  const extracted = yield* spawner.exitCode(
    ChildProcess.make("tar", ["-xzf", archivePath, "-C", temporary], {
      env: childEnvironment,
    }),
  );
  yield* check(extracted === 0, "Could not extract package.");
  const manifest = yield* fs
    .readFileString(join(temporary, "package", "package.json"))
    .pipe(
      Effect.flatMap(
        Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              name: Schema.String,
              version: Schema.String,
              dependencies: Schema.Record(Schema.String, Schema.String),
            }),
          ),
        ),
      ),
    );
  yield* check(
    manifest.name === PACKAGE.name &&
      manifest.version === PACKAGE.version &&
      Object.keys(manifest.dependencies).length ===
        Object.keys(PACKAGE.dependencies).length &&
      Object.entries(PACKAGE.dependencies).every(
        ([name, version]) => manifest.dependencies[name] === version,
      ),
    "Packed manifest differs from project metadata.",
  );

  const consumer = join(temporary, "consumer");
  yield* fs.makeDirectory(consumer);
  yield* fs.writeFileString(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "openapi-mcp-package-consumer",
      private: true,
      type: "module",
      packageManager: PACKAGE.packageManager,
      dependencies: {
        [manifest.name]: `file:${archivePath}`,
        effect: PACKAGE.dependencies.effect,
        "@effect/platform-node": PACKAGE.dependencies["@effect/platform-node"],
      },
      devDependencies: {
        "@typescript/native": PACKAGE.devDependencies["@typescript/native"],
        "@types/node": PACKAGE.devDependencies["@types/node"],
      },
    }),
  );
  const pnpmOverride = process.env.MCP_PACKAGE_PNPM_CLI;
  if (pnpmOverride !== undefined) {
    yield* check(
      isAbsolute(pnpmOverride),
      "MCP_PACKAGE_PNPM_CLI must be an absolute JavaScript CLI path.",
    );
    yield* fs.realPath(pnpmOverride);
  }
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const pnpmOutput = (args: ReadonlyArray<string>) =>
    spawner
      .string(
        ChildProcess.make(
          pnpmOverride === undefined ? "pnpm" : process.execPath,
          pnpmOverride === undefined ? args : [pnpmOverride, ...args],
          { cwd: projectRoot, env: childEnvironment, stderr: "inherit" },
        ),
      )
      .pipe(Effect.map((output) => output.trim()));
  const storeOverride = process.env.MCP_PACKAGE_STORE_DIR;
  if (storeOverride !== undefined) {
    yield* check(
      isAbsolute(storeOverride),
      "MCP_PACKAGE_STORE_DIR must be an absolute pnpm store path.",
    );
  }
  const cacheOverride = process.env.MCP_PACKAGE_CACHE_DIR;
  if (cacheOverride !== undefined) {
    yield* check(
      isAbsolute(cacheOverride),
      "MCP_PACKAGE_CACHE_DIR must be an absolute pnpm metadata cache path.",
    );
  }
  const configuredCache =
    !online && cacheOverride === undefined
      ? yield* pnpmOutput(["config", "get", "cache-dir"])
      : undefined;
  const cache =
    cacheOverride ??
    (online
      ? join(temporary, "pnpm-cache")
      : configuredCache === undefined ||
          ["", "undefined", "null"].includes(configuredCache)
        ? undefined
        : configuredCache === "~" || /^~[\\/]/.test(configuredCache)
          ? resolve(homedir(), configuredCache.slice(2))
          : resolve(projectRoot, configuredCache));
  yield* check(
    cache === undefined || !/[\r\n]/.test(cache),
    "Could not resolve pnpm's metadata cache; set MCP_PACKAGE_CACHE_DIR to its absolute path.",
  );
  // Resolve the store before changing cwd: pnpm may use a project-local store
  // when a sandbox cannot write to its usual location. Online validation gets
  // fresh registry metadata and, by default, a completely empty store.
  const store =
    storeOverride ??
    (online
      ? join(temporary, "pnpm-store")
      : yield* pnpmOutput(["store", "path"]));
  yield* check(
    isAbsolute(store) && !/[\r\n]/.test(store),
    "Could not resolve pnpm's store; set MCP_PACKAGE_STORE_DIR to its absolute path.",
  );
  const install = (production: boolean) =>
    Effect.gen(function* () {
      const args = [
        "install",
        ...(online ? ["--no-offline", "--no-prefer-offline"] : ["--offline"]),
        ...(cache === undefined ? [] : [`--config.cache-dir=${cache}`]),
        `--store-dir=${store}`,
        production ? "--prod" : "--prod=false",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--ignore-workspace",
        "--no-frozen-lockfile",
        "--no-runtime",
        "--strict-peer-dependencies",
        "--package-import-method=copy",
        "--node-linker=isolated",
        "--config.enable-global-virtual-store=false",
        "--reporter=append-only",
      ];
      const code = yield* spawner.exitCode(
        ChildProcess.make(
          pnpmOverride === undefined ? "pnpm" : process.execPath,
          pnpmOverride === undefined ? args : [pnpmOverride, ...args],
          {
            cwd: consumer,
            env: childEnvironment,
            stdout: "inherit",
            stderr: "inherit",
          },
        ),
      );
      yield* check(
        code === 0,
        online
          ? "Fresh online consumer installation failed; inspect registry, engine and peer dependency diagnostics above."
          : "Fresh offline consumer installation failed; inspect peer diagnostics and ensure dependencies are cached in the selected store, or rerun with --online.",
      );
    });
  yield* Console.log(
    online
      ? "Installing a fresh consumer from the archive and current registry metadata."
      : "Installing a fresh consumer from the archive and the project's pnpm cache.",
  );
  yield* install(true);
  const consumerRoot = yield* fs.realPath(consumer);
  const root = yield* fs.realPath(
    join(consumer, "node_modules", manifest.name),
  );
  yield* check(
    isWithin(consumerRoot, root),
    "Installed adapter resolves outside the fresh consumer.",
  );
  for (const name of ["effect", "@effect/platform-node"]) {
    const dependency = yield* fs.realPath(join(consumer, "node_modules", name));
    yield* check(
      isWithin(consumerRoot, dependency),
      `${name} resolves outside the fresh consumer.`,
    );
  }
  for (const name of [
    "typescript",
    "@typescript/native",
    "@modelcontextprotocol/client",
  ]) {
    yield* check(
      !(yield* fs.exists(join(consumer, "node_modules", name))),
      "Development dependencies leaked into the production consumer.",
    );
  }
  // Node intentionally refuses TypeScript stripping inside node_modules.
  // Run the unchanged packaged examples as consumer-owned files with bare imports.
  const examples = join(consumer, "examples");
  yield* fs.makeDirectory(examples);
  for (const name of exampleFiles) {
    yield* fs.copyFile(join(root, "examples", name), join(examples, name));
  }
  const importProbe = yield* fs.readFileString(
    fileURLToPath(new URL("./package-import-probe.mjs", import.meta.url)),
  );
  yield* fs.writeFileString(join(consumer, "probe.mjs"), importProbe);
  for (const [file, description] of [
    [join(consumer, "probe.mjs"), "Packed bare-name import/execution probe"],
    [join(examples, "library.ts"), "Packed Effect library example"],
    [join(examples, "recovery.ts"), "Packed typed recovery example"],
    [join(examples, "cancellation.ts"), "Packed cancellation example"],
  ] as const) {
    const code = yield* spawner.exitCode(
      ChildProcess.make(process.execPath, [file], {
        cwd: consumer,
        env: childEnvironment,
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    yield* check(code === 0, `${description} failed.`);
  }
  const command = join(consumer, "node_modules", ".bin", "effect-openapi-mcp");
  yield* check(yield* fs.exists(command), "Installed command is missing.");
  const help = yield* spawner.string(
    ChildProcess.make(command, ["--help"], {
      cwd: consumer,
      env: childEnvironment,
    }),
  );
  yield* check(
    help.includes("inspect") && help.includes("check"),
    "Installed command did not expose its CLI help.",
  );
  const invalidCode = yield* spawner.exitCode(
    ChildProcess.make(command, ["--package-smoke-invalid"], {
      cwd: consumer,
      env: childEnvironment,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  yield* check(
    invalidCode !== 0,
    "Installed command accepted an unknown flag.",
  );
  for (const version of protocolVersions) {
    yield* withClient(
      version,
      {
        command,
        cwd: consumer,
        env: {
          MCP_TRANSPORT: "stdio",
          MCP_OPENAPI_SPEC: join(root, "examples", "inventory.openapi.json"),
          MCP_API_BASE_URL: "https://unused.example.com",
          MCP_CREDENTIALS: '{"Key":"package-smoke-secret"}',
        },
      },
      (client) =>
        Effect.gen(function* () {
          const listing = yield* Effect.tryPromise(() => client.listTools());
          yield* check(
            listing.tools.length === 6,
            "Installed CLI returned an incomplete catalog.",
          );
          yield* check(
            !JSON.stringify(listing).includes("package-smoke-secret"),
            "Package exposed credentials.",
          );
          const invalid = yield* Effect.tryPromise(() =>
            client.callTool({ name: "get_item", arguments: {} }),
          );
          yield* check(
            invalid.isError === true,
            "Installed CLI did not validate required tool arguments.",
          );
        }),
    );
    yield* withClient(
      version,
      {
        command: process.execPath,
        args: [join(examples, "client-fixture.ts")],
        cwd: consumer,
      },
      (client) =>
        Effect.gen(function* () {
          const listing = yield* Effect.tryPromise(() => client.listTools());
          yield* check(
            JSON.stringify(listing.tools.map((tool) => tool.name)) ===
              JSON.stringify(["echo_message", "echo_text"]),
            "Packaged client fixture returned an unexpected catalog.",
          );
          const message = "package + smoke 🧪";
          const json = yield* Effect.tryPromise(() =>
            client.callTool({
              name: "echo_message",
              arguments: { query: { message, count: 3 } },
            }),
          );
          yield* check(
            json.isError !== true &&
              JSON.stringify(json.structuredContent) ===
                JSON.stringify({ message, count: 3 }),
            "Packaged client fixture failed its JSON tool call.",
          );
          const text = "Exact UTF-8 café 🧪\n";
          const echoed = yield* Effect.tryPromise(() =>
            client.callTool({ name: "echo_text", arguments: { body: text } }),
          );
          yield* check(
            echoed.isError !== true &&
              JSON.stringify(echoed.structuredContent) ===
                JSON.stringify({ result: text }),
            "Packaged client fixture failed its text tool call.",
          );
          const invalid = yield* Effect.tryPromise(() =>
            client.callTool({
              name: "echo_message",
              arguments: { query: { message: "", count: 11 } },
            }),
          );
          yield* check(
            invalid.isError === true,
            "Packaged client fixture accepted invalid arguments.",
          );
        }),
    );
    yield* Console.log(
      `Installed CLI and offline client fixture: ${version} passed.`,
    );
  }

  // Add the typecheck tools only after production-only execution.
  yield* install(false);
  yield* fs.writeFileString(join(consumer, "types.ts"), consumerTypes);
  yield* fs.writeFileString(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2024",
        lib: ["ES2024"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: ["node"],
        noEmit: true,
        allowImportingTsExtensions: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
      },
      files: ["types.ts", ...exampleFiles.map((name) => join(examples, name))],
    }),
  );
  const typeCode = yield* spawner.exitCode(
    ChildProcess.make(
      process.execPath,
      [join(consumer, "node_modules", "@typescript", "native", "bin", "tsc")],
      {
        cwd: consumer,
        env: childEnvironment,
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  );
  yield* check(
    typeCode === 0,
    "Installed public declarations failed the independent NodeNext consumer typecheck.",
  );
  yield* Console.log(
    `Fresh ${online ? "online" : "offline"} consumer install with valid peers, public imports/types, installed command and both MCP protocol eras passed.`,
  );
});
NodeRuntime.runMain(
  program.pipe(
    Effect.timeout("2 minutes"),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
