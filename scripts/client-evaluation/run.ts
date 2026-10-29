import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import EFFECT_PACKAGE from "effect/package.json" with { type: "json" };
import {
  profileMetadata,
  sanitize,
} from "../../examples/client-evaluation/profiles.ts";
import { cases } from "./cases.ts";
import { score } from "./score.ts";
import { collectUtf8 } from "./output.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const options: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key ?? "", value.join("=")];
  }),
);
const client = options.client ?? "codex";
if (!["codex", "claude"].includes(client))
  throw new Error("Choose --client=codex or --client=claude");
const binary = options.binary ?? client;
const timeout = Number(options.timeout ?? 120_000);
if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 180_000)
  throw new Error("Timeout must be positive and no greater than 180000 ms");
const output = resolve(
  options.output ??
    join(
      root,
      "reports/client-evaluation",
      new Date().toISOString().replaceAll(":", "-"),
    ),
);
mkdirSync(output, { recursive: true });
const probe = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    error: result.error?.message,
    signal: result.signal,
  };
};
const versionProbe = probe(binary, ["--version"]);
const version =
  versionProbe.status === 0 ? versionProbe.stdout.trim() : "unavailable";
const auth = probe(
  binary,
  client === "codex" ? ["login", "status"] : ["auth", "status"],
);
const authText = auth.error
  ? "unknown"
  : client === "codex"
    ? `${auth.stdout}${auth.stderr}`.includes("Logged in")
      ? "logged-in"
      : /not logged in/i.test(`${auth.stdout}${auth.stderr}`)
        ? "not-logged-in"
        : "unknown"
    : (() => {
        try {
          const status = (JSON.parse(auth.stdout) as { loggedIn?: unknown })
            .loggedIn;
          return status === true
            ? "logged-in"
            : status === false
              ? "not-logged-in"
              : "unknown";
        } catch {
          return "unknown";
        }
      })();
const commitProbe = probe("git", ["rev-parse", "HEAD"]);
const commit = commitProbe.status === 0 ? commitProbe.stdout.trim() : "unknown";
const dirtyProbe = probe("git", ["status", "--porcelain"]);
const dirty =
  dirtyProbe.status === 0
    ? dirtyProbe.stdout.trim().split("\n").filter(Boolean)
    : ["unknown; git status failed"];
const preflightDiagnostics = {
  version: {
    status: versionProbe.status,
    error: versionProbe.error,
    signal: versionProbe.signal,
  },
  auth: { status: auth.status, error: auth.error, signal: auth.signal },
  gitCommit: { status: commitProbe.status, error: commitProbe.error },
  gitStatus: { status: dirtyProbe.status, error: dirtyProbe.error },
};
if (versionProbe.status !== 0)
  console.error(
    `Client preflight failed: ${binary} --version: ${versionProbe.error ?? `exit ${String(versionProbe.status)}`}`,
  );
if (authText === "unknown")
  console.error(
    "Client authentication status could not be established; see preflightDiagnostics in metadata.json.",
  );
const selected = cases
  .filter((test) => !options.case || test.id === options.case)
  .filter((test) => !options.profile || test.profile === options.profile);
if (!selected.length) throw new Error("No matching cases");
const repetitions = Number(options.repetitions ?? 3);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3)
  throw new Error("Repetitions must be 1–3");
const metadata = await Effect.runPromise(
  Effect.forEach(
    [...new Set(selected.map((test) => test.profile))],
    profileMetadata,
  ),
);
writeFileSync(
  join(output, "metadata.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      commit,
      dirty,
      node: process.version,
      effect: EFFECT_PACKAGE.version,
      client,
      version,
      auth: authText,
      profiles: metadata,
      transport: "stdio",
      modelRequested: "client default",
      negotiatedProtocol: "unknown until wire observed",
      fixtureSource: "examples/client-evaluation/server.ts",
      preflightDiagnostics,
      normalPermissions: true,
      scope: "dummy mock data only",
    },
    null,
    2,
  ) + "\n",
);
const records: Record<string, unknown>[] = [];
runMatrix: for (const test of selected)
  for (let trial = 1; trial <= (test.core ? repetitions : 1); trial++) {
    const id = `${test.id}-${trial}`;
    const runDir = join(output, id);
    mkdirSync(runDir);
    const cwd = join(tmpdir(), `openapi-mcp-evaluation-${process.pid}-${id}`);
    mkdirSync(cwd, { recursive: true });
    const journal = join(runDir, "dispatch.jsonl");
    writeFileSync(journal, "");
    const wireJournal = join(runDir, "wire.jsonl");
    writeFileSync(wireJournal, "");
    const fixture = join(root, "scripts/client-evaluation/stdio-proxy.ts");
    const mcp = {
      command: process.execPath,
      args: [fixture, test.profile],
      env: {
        EVALUATION_JOURNAL: journal,
        EVALUATION_WIRE_JOURNAL: wireJournal,
      },
    };
    const config =
      client === "codex"
        ? `mcp_servers={evaluation={command=${JSON.stringify(mcp.command)},args=${JSON.stringify(mcp.args)},env={EVALUATION_JOURNAL=${JSON.stringify(journal)},EVALUATION_WIRE_JOURNAL=${JSON.stringify(wireJournal)}},startup_timeout_sec=30,tool_timeout_sec=50}}`
        : JSON.stringify({
            mcpServers: { evaluation: { type: "stdio", ...mcp } },
          });
    writeFileSync(join(runDir, "mcp-config.txt"), config + "\n");
    const prompt =
      "This is a bounded mock-service evaluation. Use only the connected evaluation MCP tools. Do not use shell, files, internet or other services. Never claim a tool ran unless it returned a result. All identifiers and data below are disposable dummy data.\n\n" +
      test.prompt;
    writeFileSync(join(runDir, "prompt.txt"), prompt + "\n");
    const args =
      client === "codex"
        ? [
            "-a",
            "on-request",
            "exec",
            "--ignore-user-config",
            "--ephemeral",
            "--skip-git-repo-check",
            "--json",
            "--sandbox",
            "read-only",
            "-C",
            cwd,
            "-c",
            config,
            "-c",
            "features.shell_tool=false",
            "-c",
            "features.skip_host_skill_discovery=true",
            "-c",
            'model_reasoning_effort="low"',
            prompt,
          ]
        : [
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--strict-mcp-config",
            "--mcp-config",
            config,
            "--permission-mode",
            "manual",
            "--tools",
            "",
            "--no-session-persistence",
            "--disable-slash-commands",
            "--max-budget-usd",
            "0.25",
            prompt,
          ];
    writeFileSync(
      join(runDir, "command.json"),
      JSON.stringify({ binary, args, cwd }, null, 2) + "\n",
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const started = Date.now();
    const execution = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((done) => {
      const child = spawn(binary, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill();
        }
        forceKill = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 3000);
      }, timeout);
      collectUtf8(child.stdout, (text) => {
        stdout += text;
      });
      collectUtf8(child.stderr, (text) => {
        stderr += text;
      });
      child.on("error", (error) => {
        stderr += error.message;
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        clearTimeout(forceKill);
        done({ code, signal });
      });
    });
    // JSON keys are recursively redacted. Prompts contain only the committed dummy matrix.
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return sanitize(JSON.parse(line));
        } catch {
          return line;
        }
      });
    writeFileSync(
      join(runDir, "transcript.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    writeFileSync(
      join(runDir, "stderr.txt"),
      stderr.replace(/Bearer\s+\S+/g, "Bearer [redacted]"),
    );
    const dispatch = readFileSync(journal, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const wire = readFileSync(wireJournal, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            direction: string;
            method: string;
            message?: {
              result?: { protocolVersion?: string };
              params?: {
                name?: string;
                arguments?: Record<string, unknown>;
                _meta?: { "x-codex-turn-metadata"?: { model?: string } };
              };
            };
          },
      );
    const protocol =
      wire.find(
        (event) =>
          event.direction === "server" && event.method === "initialize",
      )?.message?.result?.protocolVersion ?? "unknown";
    const model =
      wire.find(
        (event) =>
          event.method === "tools/call" && event.direction === "client",
      )?.message?.params?._meta?.["x-codex-turn-metadata"]?.model ??
      "unknown; no model identity observable";
    const acceptedDispatches = dispatch.filter(
      (event) => event.event === "dispatch",
    );
    const calls = wire
      .filter(
        (event) =>
          event.method === "tools/call" && event.direction === "client",
      )
      .map((event) => ({
        tool: event.message?.params?.name,
        arguments: event.message?.params?.arguments,
      }));
    const results = dispatch.filter((event) => event.event === "result");
    const errors = dispatch.filter((event) => event.event === "error");
    const verdict = score({
      expected: test.expected,
      calls,
      acceptedDispatchCount: acceptedDispatches.length,
      results,
      errorCount: errors.length,
      transcript: JSON.stringify(events),
      exitCode: execution.code,
      timedOut,
      authenticated: authText === "logged-in",
      clientBlocker: stderr.includes("tools/list exceeded the catalog limit")
        ? "Codex tools/list catalog item limit"
        : undefined,
    });
    const record = {
      id,
      client,
      case: test.id,
      trial,
      profile: test.profile,
      expected: test.expected,
      prompt: test.prompt,
      actual: {
        calls,
        acceptedDispatches,
        results,
        errors,
        clientEvents: events,
      },
      auth: authText,
      clientBlocker: stderr.includes("tools/list exceeded the catalog limit")
        ? "Codex tools/list catalog item limit"
        : undefined,
      modelActual: model,
      negotiatedProtocol: protocol,
      discovery: wire.filter((event) => event.method === "tools/list"),
      wireJournal: `${id}/wire.jsonl`,
      approvals: {
        mode: client === "codex" ? "on-request; read-only sandbox" : "manual",
        observed: "not inferred from annotations or dispatch",
      },
      semanticReview:
        test.expected.tools.length === 0
          ? "Human review required: zero dispatch alone does not establish completion."
          : "Expected tool result checked",
      latencyMs: Date.now() - started,
      execution,
      timedOut,
      ...verdict,
      transcript: `${id}/transcript.jsonl`,
      dispatchJournal: `${id}/dispatch.jsonl`,
    };
    records.push(record);
    writeFileSync(
      join(runDir, "record.json"),
      JSON.stringify(record, null, 2) + "\n",
    );
    writeFileSync(
      join(output, "records.json"),
      JSON.stringify(records, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        id,
        outcome: record.outcome,
        latencyMs: record.latencyMs,
        calls: calls.map((call) => call.tool),
        output,
      }),
    );
    rmSync(cwd, { recursive: true, force: true });
    if (verdict.outcome === "blocked" && options["stop-on-blocker"] !== "false")
      break runMatrix;
  }
const attempted = records.filter((record) => record.outcome !== "blocked");
const metric = (name: string) =>
  attempted.filter(
    (record) => (record.metrics as Record<string, unknown>)[name] === true,
  ).length;
writeFileSync(
  join(output, "summary.md"),
  `# Actual client evaluation\n\n${client} ${version}; auth ${authText}; ${records.length} attempted trials, ${attempted.length} evaluable, ${records.filter((record) => record.outcome === "blocked").length} blocked.\n\nSelection ${metric("selection")}/${attempted.length}; accepted expected arguments ${metric("validArguments")}/${attempted.length}; mock task completion ${metric("completion")}/${attempted.length}. These denominators exclude blocked runs and include no SDK tests. Review individual transcripts for clarifications and approval observations.\n\n| Case/trial | Profile | Outcome | Latency ms |\n| --- | --- | --- | --- |\n${records.map((record) => `| ${String(record.id)} | ${String(record.profile)} | ${String(record.outcome)} | ${String(record.latencyMs)} |`).join("\n")}\n`,
);
