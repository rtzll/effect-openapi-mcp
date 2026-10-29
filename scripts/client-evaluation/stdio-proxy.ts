import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Observe the real client protocol without altering any JSON-RPC messages.
// Tool discovery bodies are summarized; prompts contain committed dummy data.
const journal = process.env.EVALUATION_WIRE_JOURNAL;
const methods = new Map<string | number, string>();
const record = (direction: string, text: string) => {
  if (!journal) return;
  try {
    const message = JSON.parse(text) as {
      id?: string | number;
      method?: string;
      result?: { tools?: { name: string }[] };
    };
    if (
      direction === "client" &&
      message.id !== undefined &&
      message.method !== undefined
    )
      methods.set(message.id, message.method);
    const method =
      message.method ??
      (message.id === undefined ? undefined : methods.get(message.id));
    if (
      method === "initialize" ||
      method === "tools/call" ||
      method === "notifications/cancelled"
    )
      appendFileSync(
        journal,
        JSON.stringify({
          direction,
          method,
          message,
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
    else if (method === "tools/list" && direction === "server")
      appendFileSync(
        journal,
        JSON.stringify({
          direction,
          method,
          toolCount: message.result?.tools?.length,
          toolNamesHash: createHash("sha256")
            .update(
              JSON.stringify(
                message.result?.tools?.map(
                  (tool: { name: string }) => tool.name,
                ),
              ),
            )
            .digest("hex"),
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
  } catch {
    /* stdout forwarding is independent of observation. */
  }
};
const child = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../examples/client-evaluation/server.ts", import.meta.url),
    ),
    process.argv[2] ?? "echo",
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  record("client", line);
  child.stdin.write(line + "\n");
});
input.on("close", () => {
  child.stdin.end();
  child.kill("SIGTERM");
});
createInterface({ input: child.stdout }).on("line", (line) => {
  record("server", line);
  process.stdout.write(line + "\n");
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("close", (code) => {
  input.close();
  process.exitCode = code ?? 0;
});
