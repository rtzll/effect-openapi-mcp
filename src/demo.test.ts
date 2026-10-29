import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runDemo } from "../scripts/demo-program.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "Offline onboarding demo",
  (it) => {
    it.effect(
      "prints useful results and exits from an unrelated directory",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const cwd = yield* fs.makeTempDirectoryScoped({
              prefix: "demo unrelated cwd ",
            });
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const child = yield* spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [fileURLToPath(new URL("../scripts/demo.ts", import.meta.url))],
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
            expect(output.trim().split("\n")).toEqual([
              "Tools: echo_message, echo_text (read-only, offline)",
              'JSON echo: {"message":"Café + 😀","count":3}',
              'Unicode text: "é\\r\\n😀" (preserved exactly)',
              "Validation: count 11 rejected (allowed: 1–10).",
            ]);
            expect(yield* child.isRunning).toBe(false);
          }).pipe(Effect.timeout("20 seconds")),
        ),
    );

    it.effect("closes its fixture child when connection fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "demo-failure-",
          });
          const pidPath = join(directory, "pid");
          const fixture = join(directory, "empty-server.mjs");
          // A separate process returns an incompatible discovery result and stays
          // alive until the demo scope closes its stdin.
          yield* fs.writeFileString(
            fixture,
            `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[2], String(process.pid));
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
});
`,
          );
          const result = yield* runDemo({
            command: process.execPath,
            args: [fixture, pidPath],
            stderr: "pipe",
          }).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure.message).toBe(
              "Could not connect to the offline fixture.",
            );
          }
          const pid = Number(yield* fs.readFileString(pidPath));
          expect(pid).toBeGreaterThan(0);
          expect(() => process.kill(pid, 0)).toThrow();
        }).pipe(Effect.timeout("20 seconds")),
      ),
    );
  },
);
