import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Effect,
  Fiber,
  FileSystem,
  Path,
  PlatformError,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BuildError, buildProject } from "./build.ts";

const Invocation = Schema.fromJsonString(
  Schema.Struct({
    executable: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.String,
    outputExisted: Schema.Boolean,
  }),
);

const project = Effect.fnUntraced(function* (
  behavior: "success" | "failure" | "wait" = "success",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mcp-build-" });
  const root = path.join(directory, "project with spaces & $literal");
  const compiler = path.join(
    root,
    "node_modules",
    "@typescript",
    "native",
    "bin",
    "tsc",
  );
  yield* fs.makeDirectory(path.dirname(compiler), { recursive: true });
  yield* fs.makeDirectory(path.join(root, "src"));
  yield* fs.makeDirectory(path.join(root, "dist", "nested"), {
    recursive: true,
  });
  yield* fs.makeDirectory(path.join(root, "distribution"));
  yield* fs.writeFileString(path.join(root, "src", "retained.ts"), "source");
  yield* fs.writeFileString(
    path.join(root, "README.md"),
    "retained documentation",
  );
  yield* fs.writeFileString(
    path.join(root, "distribution", "retained.js"),
    "neighbor",
  );
  yield* fs.writeFileString(
    path.join(root, "dist", "obsolete.js"),
    "stale output",
  );
  yield* fs.writeFileString(
    path.join(root, "dist", "nested", "obsolete.d.ts"),
    "stale declaration",
  );
  yield* fs.writeFileString(path.join(root, "tsconfig.build.json"), "{}");
  // This fixture executes through the real native spawner, but never compiles the shared source tree.
  yield* fs.writeFileString(
    compiler,
    `const fs = require("node:fs");
fs.writeFileSync("invocation.json", JSON.stringify({
  executable: process.execPath,
  args: process.argv.slice(1),
  cwd: process.cwd(),
  outputExisted: fs.existsSync("dist")
}));
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/current.js", "new output");
${
  behavior === "failure"
    ? "process.exitCode = 7;"
    : behavior === "wait"
      ? 'fs.writeFileSync("started", "ready"); setInterval(() => {}, 1000);'
      : ""
}
`,
  );
  return { root, compiler };
});

it.layer(NodeServices.layer)("Clean native build lifecycle", (it) => {
  it.effect(
    "removes stale output before compiling with the exact executable, arguments and cwd",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, compiler } = yield* project();
        yield* buildProject(root);
        const invocation = yield* fs
          .readFileString(path.join(root, "invocation.json"))
          .pipe(Effect.flatMap(Schema.decodeEffect(Invocation)));
        expect(invocation).toEqual({
          executable: process.execPath,
          args: [compiler, "-p", path.join(root, "tsconfig.build.json")],
          cwd: yield* fs.realPath(root),
          outputExisted: false,
        });
        expect(yield* fs.readDirectory(path.join(root, "dist"))).toEqual([
          "current.js",
        ]);
        expect(
          yield* fs.readFileString(path.join(root, "dist", "current.js")),
        ).toBe("new output");
        expect(
          yield* fs.readFileString(path.join(root, "src", "retained.ts")),
        ).toBe("source");
        expect(yield* fs.readFileString(path.join(root, "README.md"))).toBe(
          "retained documentation",
        );
        expect(
          yield* fs.readFileString(
            path.join(root, "distribution", "retained.js"),
          ),
        ).toBe("neighbor");
        expect(yield* fs.exists(compiler)).toBe(true);
      }),
  );

  it.effect(
    "keeps compiler failure typed and removes partially emitted output",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root } = yield* project("failure");
        const failure = yield* Effect.flip(buildProject(root));
        expect(failure).toBeInstanceOf(BuildError);
        expect(failure).toMatchObject({ exitCode: 7 });
        expect(yield* fs.exists(path.join(root, "dist"))).toBe(false);
        expect(
          yield* fs.readFileString(path.join(root, "src", "retained.ts")),
        ).toBe("source");
        expect(yield* fs.exists(path.join(root, "invocation.json"))).toBe(true);
      }),
  );

  it.effect(
    "fails with a typed compiler exit when the compiler is absent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Suppress the expected Node diagnostic while still executing the real missing-file command.
        const quiet = ChildProcessSpawner.make((command) =>
          command._tag === "StandardCommand"
            ? native.spawn(
                ChildProcess.make(command.command, command.args, {
                  ...command.options,
                  stderr: "ignore",
                }),
              )
            : Effect.die("The build must execute one compiler command."),
        );
        const { root, compiler } = yield* project();
        yield* fs.remove(compiler);
        const failure = yield* Effect.flip(
          buildProject(root).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              quiet,
            ),
          ),
        );
        expect(failure).toBeInstanceOf(BuildError);
        expect(failure).toMatchObject({ exitCode: 1 });
        expect(yield* fs.exists(path.join(root, "dist"))).toBe(false);
        expect(yield* fs.exists(path.join(root, "invocation.json"))).toBe(
          false,
        );
      }),
  );

  it.effect(
    "propagates a native platform failure for a nonexistent project directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "mcp-build-missing-",
        });
        const root = path.join(directory, "missing");
        const failure = yield* Effect.flip(buildProject(root));
        expect(PlatformError.isPlatformError(failure)).toBe(true);
        expect(yield* fs.exists(root)).toBe(false);
      }),
  );

  it.effect(
    "replaces a dist symlink without deleting files in its target",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root } = yield* project();
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "mcp-build-outside-",
        });
        yield* fs.writeFileString(
          path.join(outside, "retained.js"),
          "outside output",
        );
        const output = path.join(root, "dist");
        yield* fs.remove(output, { recursive: true });
        yield* fs.symlink(outside, output);
        yield* buildProject(root);
        expect(
          yield* fs.readFileString(path.join(outside, "retained.js")),
        ).toBe("outside output");
        expect(yield* fs.realPath(output)).toBe(
          path.join(yield* fs.realPath(root), "dist"),
        );
        expect(yield* fs.readDirectory(output)).toEqual(["current.js"]);
      }),
  );
});

it.live(
  "interrupting a compiler removes partial output after terminating the child",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const tracked = yield* Ref.make<
        ChildProcessSpawner.ChildProcessHandle | undefined
      >(undefined);
      const tracking = ChildProcessSpawner.make((command) =>
        native
          .spawn(command)
          .pipe(Effect.tap((child) => Ref.set(tracked, child))),
      );
      const { root } = yield* project("wait");
      const compiling = yield* buildProject(root).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          tracking,
        ),
        Effect.forkChild,
      );
      yield* fs.exists(path.join(root, "started")).pipe(
        Effect.repeat({
          until: (started) => started,
          schedule: Schedule.spaced("10 millis"),
        }),
        Effect.timeout("5 seconds"),
      );
      expect(yield* fs.exists(path.join(root, "dist", "current.js"))).toBe(
        true,
      );
      const child = yield* Ref.get(tracked);
      if (child === undefined)
        return yield* Effect.die("Expected a running compiler.");
      expect(yield* child.isRunning).toBe(true);
      yield* Fiber.interrupt(compiling);
      expect(yield* child.isRunning).toBe(false);
      expect(yield* fs.exists(path.join(root, "dist"))).toBe(false);
      expect(
        yield* fs.readFileString(path.join(root, "src", "retained.ts")),
      ).toBe("source");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  10_000,
);
