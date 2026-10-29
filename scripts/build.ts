import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Data, Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class BuildError extends Data.TaggedError("BuildError")<{
  exitCode: number;
}> {}

export const buildProject = Effect.fn("buildProject")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = path.resolve(root);
  const output = path.join(directory, "dist");
  const clean = fs.remove(output, { recursive: true, force: true });
  yield* clean;
  // Stop the scoped compiler before cleaning failed or interrupted output.
  yield* Effect.uninterruptibleMask((restore) =>
    restore(
      Effect.gen(function* () {
        const exitCode = yield* spawner.exitCode(
          ChildProcess.make(
            process.execPath,
            [
              path.join(
                directory,
                "node_modules",
                "@typescript",
                "native",
                "bin",
                "tsc",
              ),
              "-p",
              path.join(directory, "tsconfig.build.json"),
            ],
            { cwd: directory, stdout: "inherit", stderr: "inherit" },
          ),
        );
        if (exitCode !== 0) return yield* new BuildError({ exitCode });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        clean.pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    ),
  );
});

if (import.meta.main) {
  NodeRuntime.runMain(
    buildProject(fileURLToPath(new URL("..", import.meta.url))).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
}
