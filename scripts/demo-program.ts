import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import { Data, Effect, Schema } from "effect";

export const fixturePath = fileURLToPath(
  new URL("../examples/client-fixture.ts", import.meta.url),
);

export class DemoError extends Data.TaggedError("DemoError")<{
  message: string;
  cause?: unknown;
}> {}

const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new DemoError({ message }));
const request = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DemoError({ message, cause }),
  });

// The scope owns both the SDK client and its fixture child, including failed
// connection/validation and interruption. Nothing is left running afterward.
export const runDemo = (
  server: StdioServerParameters = {
    command: process.execPath,
    args: [fixturePath],
    stderr: "pipe",
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* Effect.acquireRelease(
        Effect.sync(() => new StdioClientTransport(server)),
        (resource) =>
          request("Could not close the fixture process.", () =>
            resource.close(),
          ).pipe(Effect.orDie),
      );
      // Drain diagnostics without mixing server logs into the human summary.
      transport.stderr?.on("data", () => {});
      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Client(
              { name: "openapi-offline-demo", version: "1.0.0" },
              { versionNegotiation: { mode: { pin: "2026-07-28" } } },
            ),
        ),
        (resource) =>
          request("Could not close the demo client.", () =>
            resource.close(),
          ).pipe(Effect.orDie),
      );
      yield* request("Could not connect to the offline fixture.", () =>
        client.connect(transport),
      );
      const listing = yield* request("Could not discover fixture tools.", () =>
        client.listTools(),
      );
      const names = listing.tools.map((tool) => tool.name).sort();
      yield* check(
        names.length === 2 &&
          names[0] === "echo_message" &&
          names[1] === "echo_text" &&
          listing.tools.every(
            (tool) => tool.annotations?.readOnlyHint === true,
          ),
        "Expected exactly the two read-only fixture tools.",
      );
      const message = "Café + 😀";
      const json = yield* request("JSON echo failed.", () =>
        client.callTool({
          name: "echo_message",
          arguments: { query: { message, count: 3 } },
        }),
      );
      const echoedJson = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ message: Schema.String, count: Schema.Finite }),
      )(json.structuredContent).pipe(
        Effect.mapError(
          (cause) => new DemoError({ message: "Unexpected JSON echo.", cause }),
        ),
      );
      yield* check(
        json.isError !== true &&
          echoedJson.message === message &&
          echoedJson.count === 3,
        "The JSON echo changed the supplied arguments.",
      );
      const text = "é\r\n😀";
      const unicode = yield* request("Unicode text echo failed.", () =>
        client.callTool({ name: "echo_text", arguments: { body: text } }),
      );
      const echoedText = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ result: Schema.String }),
      )(unicode.structuredContent).pipe(
        Effect.mapError(
          (cause) => new DemoError({ message: "Unexpected text echo.", cause }),
        ),
      );
      yield* check(
        unicode.isError !== true && echoedText.result === text,
        "The Unicode text echo changed the supplied text.",
      );
      const invalid = yield* request("Invalid-count check failed.", () =>
        client.callTool({
          name: "echo_message",
          arguments: { query: { message, count: 11 } },
        }),
      );
      yield* check(invalid.isError === true, "Count 11 should be rejected.");
      return [
        `Tools: ${names.join(", ")} (read-only, offline)`,
        `JSON echo: ${JSON.stringify(echoedJson)}`,
        `Unicode text: ${JSON.stringify(echoedText.result)} (preserved exactly)`,
        "Validation: count 11 rejected (allowed: 1–10).",
      ];
    }).pipe(Effect.timeout("15 seconds")),
  );
