import { DEFAULT_PARAMETER_PROFILE } from "../src/parameter-profile.ts";
import { cpus, platform, arch } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import PACKAGE from "../package.json" with { type: "json" };
import {
  CORPUS,
  CORPUS_CASES,
  CorpusError,
  auditFixture,
  projectPath,
  sha256,
  summarizeResult,
  type CorpusCase,
  type ResultSummary,
  type Timings,
} from "./corpus.ts";

const args = new Set(process.argv.slice(2));
const benchmark = args.has("--benchmark");
const update = args.has("--update");
const includeStrict = args.has("--include-strict");
const cases = CORPUS_CASES.filter(
  (entry) =>
    !benchmark ||
    includeStrict ||
    entry.parameterProfile === DEFAULT_PARAMETER_PROFILE,
);
const SAMPLES = 5;
type Row = CorpusCase &
  Readonly<{
    bytes: number;
    result: ResultSummary;
    samples: ReadonlyArray<Timings>;
  }>;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const metric = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
};
const ms = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return "—";
  const stats = metric(values);
  return `${stats.median.toFixed(1)} / ${stats.max.toFixed(1)}`;
};
const markdown = (rows: ReadonlyArray<Row>, environment: unknown) => {
  const lines = [
    `# Public-spec ${benchmark ? "benchmark" : "compatibility"} report`,
    "",
    "Compilation and schema-export coverage only; this report does not execute API requests or establish support for every schema-valid input. Generated offline from immutable, unchanged upstream documents. Spec, compressed-file, license and notice hashes are verified on every read. No API calls or external-reference fetching.",
    "",
    "| Spec | Profile | Version | MB | Parsed | Declared entries | Compiled tools | Excluded operations | Result |",
    "| --- | --- | --- | ---: | --- | ---: | ---: | ---: | --- |",
  ];
  for (const { source, parameterProfile, bytes, result } of rows) {
    const survey =
      result.status === "parse-rejected" ? undefined : result.survey;
    const compiled = result.status === "compiled";
    lines.push(
      `| [${source.name}](${source.artifact?.url ?? source.url}) (${source.kind}) | ${parameterProfile} | ${source.version} | ${(bytes / 1e6).toFixed(2)} | ${result.status === "parse-rejected" ? "no" : "yes"} | ${survey?.declaredOperations ?? "unknown"} | ${compiled ? result.tools.count : "—"} | ${compiled ? result.unsupported.length : "—"} | ${result.status} |`,
    );
  }
  lines.push(
    "",
    "Declared entries include fixed methods and 3.2 additionalOperations. Referenced entries have unresolved definitions; referenced path items can conceal further operations. Rejected documents receive no coverage percentage. Tools means input schemas exported successfully, not live endpoint verification. Webhooks/callbacks are reported separately in JSON and are not callable tools.",
    "",
    "The default brackets-indexed profile uses nested indexed brackets for declared deepObject query/form fields. The explicit spec profile restricts encoding to portable OpenAPI shapes.",
    benchmark && !includeStrict
      ? "This benchmark measures the default configuration only. Run vp run benchmark --include-strict to compare both profiles."
      : "Both profiles are measured independently against every unchanged fixture.",
  );
  lines.push("", "## Findings", "");
  for (const { source, parameterProfile, result } of rows) {
    lines.push(`### ${source.name} (${parameterProfile})`, "");
    if (source.licenseNote !== undefined) lines.push(source.licenseNote, "");
    if (source.notices !== undefined) {
      lines.push(
        `Additional upstream notices: ${source.notices.map((notice) => `[${notice.file}](${notice.url})`).join(", ")}.`,
        "",
      );
    }
    if (source.artifact !== undefined) {
      lines.push(
        `Unchanged bundle from the [upstream build](${source.artifact.workflowRunUrl}) of the [pinned source](${source.url}); artifact and archive provenance are recorded in the fixture manifest.`,
        "",
      );
    }
    if (result.status === "parse-rejected") {
      lines.push(`Parser rejection: ${result.reason}`);
    } else if (result.status === "compile-rejected") {
      // A zero-tool failure can contain hundreds of operation diagnostics.
      // Full text remains in JSON and in the approved regression baseline.
      lines.push(`Compiler rejection: ${result.reason.split("; ")[0]}.`);
    } else {
      const grouped = new Map<string, number>();
      for (const diagnostic of result.unsupported) {
        grouped.set(
          diagnostic.reason,
          (grouped.get(diagnostic.reason) ?? 0) + 1,
        );
      }
      if (grouped.size === 0)
        lines.push("All declared operations compile and export.");
      for (const [reason, count] of [...grouped].sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${count}: ${reason.replaceAll("\n", " ")}`);
      }
      for (const problem of result.problems)
        lines.push(`- Audit failure: ${problem}`);
      for (const failure of result.exportFailures)
        lines.push(
          `- Export failure: ${failure.method} ${failure.path}: ${failure.reason}`,
        );
    }
    if (result.status !== "parse-rejected") {
      const s = result.survey;
      lines.push(
        "",
        `Observed boundaries: ${s.referencedOperations} operation refs; ${s.referencedPathItems} path-item refs; ${s.externalReferenceStrings} non-fragment $ref strings; ${s.webhooks} webhook entries; ${s.callbacks} callback declarations.`,
      );
    }
    lines.push("");
  }
  if (benchmark) {
    lines.push(
      "## Timings",
      "",
      "One discarded full warmup followed by five sequential full runs per fixture. Each run parses fresh text, constructs a new native Effect catalog, and exports/hashes all tool input schemas. Timings exclude file reads, decompression, provenance checks, raw-document survey, accounting and baseline comparison. Compiler timing includes boundary decoding and reachable schema import. Export timing includes name/credential checks and hashing of input schemas and wire contracts. Explicit GC runs between iterations outside the timed regions; no GC runs inside phases. Timings are observations with no CI performance threshold. Median / maximum milliseconds; five samples are insufficient to estimate a meaningful p95.",
      "",
      "| Spec | Profile | Parse ms | Compile ms | Export ms |",
      "| --- | --- | ---: | ---: | ---: |",
    );
    for (const { source, parameterProfile, samples } of rows) {
      lines.push(
        `| ${source.name} | ${parameterProfile} | ${ms(samples.map((s) => s.parseMs))} | ${ms(samples.flatMap((s) => (s.compileMs === null ? [] : [s.compileMs])))} | ${ms(samples.flatMap((s) => (s.exportMs === null ? [] : [s.exportMs])))} |`,
      );
    }
    lines.push(
      "",
      "Environment and adapter-source fingerprint:",
      "",
      "```json",
      json(environment).trimEnd(),
      "```",
      "",
    );
  }
  lines.push(
    "This corpus complements the official JSON Schema subset, protocol tests and mock-API wire tests. It cannot establish compatibility with every OpenAPI document or real service behavior. See the [compatibility reference](../README.md#compatibility-reference).",
    "",
  );
  return lines.join("\n");
};

const program = Effect.gen(function* () {
  if (
    [...args].some(
      (arg) => !["--benchmark", "--update", "--include-strict"].includes(arg),
    ) ||
    (benchmark && update) ||
    (includeStrict && !benchmark)
  ) {
    return yield* new CorpusError({
      message: "Use --benchmark [--include-strict] or --update, separately.",
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const harnessContents = yield* Effect.forEach(
    ["corpus.ts", "compatibility.ts"],
    (name) =>
      fs
        .readFileString(projectPath(`scripts/${name}`))
        .pipe(Effect.map((text) => `${name}\n${text}`)),
  );
  const harnessSourceSha256 = sha256(harnessContents.join("\n"));
  const rows = yield* Effect.forEach(cases, ({ source, parameterProfile }) =>
    Effect.gen(function* () {
      globalThis.gc?.();
      const warmup = yield* auditFixture(source, parameterProfile);
      const expected = summarizeResult(warmup.result);
      const samples: Timings[] = [];
      if (benchmark) {
        for (let iteration = 0; iteration < SAMPLES; iteration++) {
          globalThis.gc?.();
          const run = yield* auditFixture(source, parameterProfile);
          if (!isDeepStrictEqual(summarizeResult(run.result), expected)) {
            return yield* new CorpusError({
              message: `${source.file} (${parameterProfile}): nondeterministic compatibility result.`,
            });
          }
          samples.push(run.timings);
        }
      }
      yield* Console.log(
        `${source.name} (${parameterProfile}${parameterProfile === DEFAULT_PARAMETER_PROFILE ? ", default" : ", strict"}): ${expected.status}${expected.status === "compiled" ? `, ${expected.tools.count} compiled tools / ${expected.unsupported.length} excluded` : ""}`,
      );
      return {
        source,
        parameterProfile,
        result: expected,
        bytes: warmup.bytes,
        samples,
      } satisfies Row;
    }),
  );
  for (const { source, result } of rows) {
    if (
      result.status === "compiled" &&
      (result.problems.length > 0 || result.exportFailures.length > 0)
    ) {
      return yield* new CorpusError({
        message: `${source.file}: accounting or tool export failed.`,
      });
    }
  }
  const baselinePath = projectPath("fixtures/corpus-baseline.json");
  const actual = rows.map((row) => ({
    file: row.source.file,
    parameterProfile: row.parameterProfile,
    result: row.result,
  }));
  if (update) {
    yield* fs.writeFileString(baselinePath, json(actual));
  } else {
    const baselineText = yield* fs.readFileString(baselinePath);
    const baseline: unknown = yield* Effect.try({
      try: () => {
        const value: unknown = JSON.parse(baselineText);
        return value;
      },
      catch: () => new CorpusError({ message: "Invalid corpus baseline." }),
    });
    const expected =
      benchmark && !includeStrict && Array.isArray(baseline)
        ? baseline.filter(
            (row: unknown) =>
              typeof row === "object" &&
              row !== null &&
              "parameterProfile" in row &&
              row.parameterProfile === DEFAULT_PARAMETER_PROFILE,
          )
        : baseline;
    if (!isDeepStrictEqual(actual, expected)) {
      return yield* new CorpusError({
        message:
          "Compatibility differs from the approved baseline; review results before --update.",
      });
    }
  }
  const sourceFiles = (yield* fs.readDirectory(projectPath("src")))
    .filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !name.endsWith("fixtures.ts"),
    )
    .sort();
  const sourceContents = yield* Effect.forEach(sourceFiles, (name) =>
    fs
      .readFileString(projectPath(`src/${name}`))
      .pipe(Effect.map((text) => `${name}\n${text}`)),
  );
  const lock = yield* fs.readFileString(projectPath("pnpm-lock.yaml"));
  const environment = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    effect: PACKAGE.dependencies.effect,
    adapterSourceSha256: sha256(sourceContents.join("\n")),
    harnessSourceSha256,
    lockfileSha256: sha256(lock),
    warmups: benchmark ? 1 : 0,
    samples: benchmark ? SAMPLES : 1,
    explicitGc: typeof globalThis.gc === "function",
  };
  yield* fs.makeDirectory(projectPath("reports"), { recursive: true });
  const name = benchmark ? "benchmark" : "compatibility";
  yield* fs.writeFileString(
    projectPath(`reports/${name}.json`),
    json(benchmark ? { environment, rows } : { rows }),
  );
  yield* fs.writeFileString(
    projectPath(`reports/${name}.md`),
    markdown(rows, environment),
  );
  yield* Console.log(
    `Wrote reports/${name}.{md,json}; ${cases.length} cases across ${CORPUS.length} fixtures match the baseline.`,
  );
});
NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)));
