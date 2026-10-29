import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect, FileSystem } from "effect";

const fixturePath = fileURLToPath(
  new URL("../examples/client-fixture.ts", import.meta.url),
);

export class ClientConfigError extends Data.TaggedError("ClientConfigError")<{
  message: string;
  cause?: unknown;
}> {}

export const createClientConfig = Effect.fn("createClientConfig")(function* (
  nodePath: string = process.execPath,
  serverPath: string = fixturePath,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const [label, path] of [
    ["Node executable", nodePath],
    ["Fixture", serverPath],
  ] as const) {
    if (!isAbsolute(path)) {
      return yield* new ClientConfigError({
        message: `${label} path must be absolute.`,
      });
    }
    const info = yield* fs.stat(path).pipe(
      Effect.mapError(
        (cause) =>
          new ClientConfigError({
            message: `${label} file is unavailable: ${path}`,
            cause,
          }),
      ),
    );
    if (info.type !== "File") {
      return yield* new ClientConfigError({
        message: `${label} path must name a file.`,
      });
    }
  }
  return {
    mcpServers: {
      "openapi-fixture": {
        type: "stdio" as const,
        command: nodePath,
        args: [serverPath],
      },
    },
  };
});
