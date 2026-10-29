import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Data, Effect, FileSystem, Redacted, Schema } from "effect";
import { Tool } from "effect/ai";
import SOURCES from "../fixtures/sources.json" with { type: "json" };
import { parseOpenApi } from "../src/catalog.ts";
import { OpenApiError } from "../src/openapi-errors.ts";
import { HTTP_METHODS } from "../src/openapi-types.ts";
import { compileOpenApi, type OperationDiagnostic } from "../src/openapi.ts";
import {
  DEFAULT_PARAMETER_PROFILE,
  type ParameterProfile,
} from "../src/parameter-profile.ts";

const Source = Schema.Struct({
  name: Schema.NonEmptyString,
  file: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  kind: Schema.Literals(["api", "example", "legacy"]),
  url: Schema.NonEmptyString,
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  license: Schema.NonEmptyString,
  licenseFile: Schema.NonEmptyString,
  licenseUrl: Schema.NonEmptyString,
  licenseSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  licenseNote: Schema.optionalKey(Schema.NonEmptyString),
  notices: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        file: Schema.NonEmptyString,
        url: Schema.NonEmptyString,
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      }),
    ),
  ),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  storedSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  artifact: Schema.optionalKey(
    Schema.Struct({
      url: Schema.NonEmptyString,
      workflowRunUrl: Schema.NonEmptyString,
      archiveUrl: Schema.NonEmptyString,
      archiveSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
  ),
});
export const CORPUS = Schema.decodeUnknownSync(Schema.Array(Source))(SOURCES);
export type CorpusSource = typeof Source.Type;
export type CorpusCase = Readonly<{
  source: CorpusSource;
  parameterProfile: ParameterProfile;
}>;
// Test both profiles on every fixture; list the shipping default first.
export const CORPUS_CASES: ReadonlyArray<CorpusCase> = CORPUS.flatMap(
  (source): ReadonlyArray<CorpusCase> => [
    { source, parameterProfile: DEFAULT_PARAMETER_PROFILE },
    { source, parameterProfile: "spec" },
  ],
);
export class CorpusError extends Data.TaggedError("CorpusError")<{
  message: string;
}> {}
export const projectPath = (path: string) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export const readFixture = Effect.fn("corpus.read")(function* (
  source: CorpusSource,
) {
  const fs = yield* FileSystem.FileSystem;
  const stored = yield* fs.readFile(projectPath(`fixtures/${source.file}`));
  const license = yield* fs.readFile(
    projectPath(`fixtures/${source.licenseFile}`),
  );
  for (const notice of source.notices ?? []) {
    const contents = yield* fs.readFile(projectPath(`fixtures/${notice.file}`));
    if (sha256(contents) !== notice.sha256) {
      return yield* new CorpusError({
        message: `${source.file}: upstream notice ${notice.file} hash mismatch.`,
      });
    }
  }
  return yield* Effect.try({
    try: () => {
      const bytes = source.file.endsWith(".gz") ? gunzipSync(stored) : stored;
      if (
        sha256(stored) !== source.storedSha256 ||
        sha256(bytes) !== source.sha256 ||
        sha256(license) !== source.licenseSha256
      ) {
        throw new Error("Spec or upstream license hash mismatch.");
      }
      return { text: Buffer.from(bytes).toString("utf8"), bytes: bytes.length };
    },
    catch: (error) =>
      new CorpusError({ message: `${source.file}: ${errorMessage(error)}` }),
  });
});

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
type OperationKey = Readonly<{ method: string; path: string }>;
export type Survey = Readonly<{
  version: string;
  operations: ReadonlyArray<OperationKey>;
  referencedOperations: number;
  referencedPathItems: number;
  externalReferenceStrings: number;
  webhooks: number;
  callbacks: number;
}>;

// Survey raw JSON before decoding: the compiler's supported subset cannot
// erase the denominator or make unresolved references look like a passing API.
export const surveyDocument = (value: unknown): Survey => {
  const document = record(value);
  const operations: OperationKey[] = [];
  let referencedOperations = 0;
  let referencedPathItems = 0;
  let callbacks = 0;
  for (const [path, raw] of Object.entries(record(document.paths))) {
    if (path.startsWith("x-")) continue;
    const item = record(raw);
    if (typeof item.$ref === "string") referencedPathItems++;
    for (const method of HTTP_METHODS) {
      if (!Object.hasOwn(item, method)) continue;
      const operation = record(item[method]);
      operations.push({ method, path });
      if (typeof operation.$ref === "string") referencedOperations++;
      callbacks += Object.keys(record(operation.callbacks)).filter(
        (name) => !name.startsWith("x-"),
      ).length;
    }
    for (const [method, rawOperation] of Object.entries(
      record(item.additionalOperations),
    )) {
      operations.push({ method, path });
      const operation = record(rawOperation);
      if (typeof operation.$ref === "string") referencedOperations++;
      callbacks += Object.keys(record(operation.callbacks)).filter(
        (name) => !name.startsWith("x-"),
      ).length;
    }
  }
  let externalReferenceStrings = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const entry of node) {
        const value: unknown = entry;
        pending.push(value);
      }
    } else if (typeof node === "object" && node !== null) {
      const object = record(node);
      if (typeof object.$ref === "string" && !object.$ref.startsWith("#")) {
        externalReferenceStrings++;
      }
      pending.push(...Object.values(object));
    }
  }
  return {
    version:
      typeof document.openapi === "string"
        ? document.openapi
        : typeof document.swagger === "string"
          ? document.swagger
          : "undeclared",
    operations: operations.sort(compareOperation),
    referencedOperations,
    referencedPathItems,
    externalReferenceStrings,
    webhooks: Object.keys(record(document.webhooks)).filter(
      (name) => !name.startsWith("x-"),
    ).length,
    callbacks,
  };
};
const compareOperation = (a: OperationKey, b: OperationKey) =>
  a.path.localeCompare(b.path) || a.method.localeCompare(b.method);
const key = ({ method, path }: OperationKey) => `${method} ${path}`;

type ExportedTool = OperationKey &
  Readonly<{ name: string; inputSha256: string; wireSha256: string }>;
export type AuditResult =
  | Readonly<{ status: "parse-rejected"; reason: string }>
  | Readonly<{ status: "compile-rejected"; survey: Survey; reason: string }>
  | Readonly<{
      status: "compiled";
      survey: Survey;
      tools: ReadonlyArray<ExportedTool>;
      unsupported: ReadonlyArray<OperationDiagnostic>;
      exportFailures: ReadonlyArray<OperationDiagnostic>;
      problems: ReadonlyArray<string>;
    }>;
export type Timings = Readonly<{
  parseMs: number;
  compileMs: number | null;
  exportMs: number | null;
}>;
export type AuditRun = Readonly<{ result: AuditResult; timings: Timings }>;
const AUDIT_TOKEN = "audit-user:audit-fixture-token";

export const auditDocument = (
  text: string,
  parameterProfile: ParameterProfile = DEFAULT_PARAMETER_PROFILE,
): AuditRun => {
  let started = performance.now();
  let document: unknown;
  try {
    document = parseOpenApi(text);
  } catch (error) {
    return {
      result: { status: "parse-rejected", reason: errorMessage(error) },
      timings: {
        parseMs: performance.now() - started,
        compileMs: null,
        exportMs: null,
      },
    };
  }
  const parseMs = performance.now() - started;
  const survey = surveyDocument(document);
  const credentials = Object.fromEntries(
    Object.keys(record(record(record(document).components).securitySchemes))
      .flatMap((name) => [
        name,
        `#/components/securitySchemes/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      ])
      .map((name) => [name, Redacted.make(AUDIT_TOKEN)]),
  );
  started = performance.now();
  let catalog: ReturnType<typeof compileOpenApi>;
  try {
    catalog = compileOpenApi(document, {
      credentials,
      baseUrl: new URL("https://mock.example.com/v1/"),
      parameterProfile,
    });
  } catch (error) {
    if (!(error instanceof OpenApiError)) throw error;
    return {
      result: {
        status: "compile-rejected",
        survey,
        reason: errorMessage(error),
      },
      timings: {
        parseMs,
        compileMs: performance.now() - started,
        exportMs: null,
      },
    };
  }
  const compileMs = performance.now() - started;
  started = performance.now();
  const tools: ExportedTool[] = [];
  const exportFailures: OperationDiagnostic[] = [];
  const problems: string[] = [];
  const names = new Set<string>();
  for (const operation of catalog.operations) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(operation.name) ||
      names.has(operation.name)
    ) {
      problems.push(`Invalid or duplicate tool name: ${operation.name}`);
    }
    names.add(operation.name);
    try {
      const input = Tool.getJsonSchema(
        Tool.dynamic(operation.name, {
          parameters: operation.parametersSchema,
        }),
      );
      const json = JSON.stringify(input);
      if (input.type !== "object")
        problems.push(`Non-object input: ${operation.name}`);
      if (json.includes(AUDIT_TOKEN))
        problems.push(`Credential in input: ${operation.name}`);
      tools.push({
        method: operation.method,
        path: operation.path,
        name: operation.name,
        inputSha256: sha256(json),
        wireSha256: sha256(
          JSON.stringify({
            parameters: operation.parameters,
            authentication: operation.authentication.map(
              ({ scheme, location, name }) => ({ scheme, location, name }),
            ),
            body: operation.body,
            responseContentTypes: operation.responseContentTypes,
            responseTextContentTypes: operation.responseTextContentTypes,
            responseBinaryContentTypes: operation.responseBinaryContentTypes,
            responses: operation.responses,
            annotations: operation.annotations,
          }),
        ),
      });
    } catch (error) {
      exportFailures.push({
        method: operation.method,
        path: operation.path,
        reason: errorMessage(error),
      });
    }
  }
  const exportMs = performance.now() - started;
  const accounted = [...catalog.operations, ...catalog.unsupported]
    .sort(compareOperation)
    .map(key);
  if (
    JSON.stringify(accounted) !== JSON.stringify(survey.operations.map(key))
  ) {
    problems.push(
      "Declared operations differ from supported plus diagnosed operations.",
    );
  }
  if (catalog.filtered.length > 0)
    problems.push("Unexpected operation filters.");
  if (survey.referencedPathItems > 0)
    problems.push(
      "Unresolved path items cannot establish complete operation coverage.",
    );
  return {
    result: {
      status: "compiled",
      survey,
      tools: tools.sort(compareOperation),
      unsupported: [...catalog.unsupported].sort(compareOperation),
      exportFailures: exportFailures.sort(compareOperation),
      problems,
    },
    timings: { parseMs, compileMs, exportMs },
  };
};

export const auditFixture = Effect.fn("corpus.audit")(function* (
  source: CorpusSource,
  parameterProfile: ParameterProfile = DEFAULT_PARAMETER_PROFILE,
) {
  const fixture = yield* readFixture(source);
  const run = yield* Effect.try({
    try: () => auditDocument(fixture.text, parameterProfile),
    catch: (error) => new CorpusError({ message: errorMessage(error) }),
  });
  if (
    run.result.status !== "parse-rejected" &&
    run.result.survey.version !== source.version
  ) {
    return yield* new CorpusError({
      message: `${source.file}: declared version differs from manifest.`,
    });
  }
  return { ...run, bytes: fixture.bytes };
});

export const summarizeResult = (result: AuditResult) => {
  if (result.status === "parse-rejected") return result;
  const { operations, ...survey } = result.survey;
  const summary = {
    ...survey,
    declaredOperations: operations.length,
    operationsSha256: sha256(JSON.stringify(operations)),
  };
  return result.status === "compile-rejected"
    ? { ...result, survey: summary }
    : {
        ...result,
        survey: summary,
        tools: {
          count: result.tools.length,
          catalogSha256: sha256(JSON.stringify(result.tools)),
        },
      };
};
export type ResultSummary = ReturnType<typeof summarizeResult>;
