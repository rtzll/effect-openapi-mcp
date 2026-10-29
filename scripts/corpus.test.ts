import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { expect, it } from "@effect/vitest";
import BASELINE from "../fixtures/corpus-baseline.json" with { type: "json" };
import {
  CORPUS,
  CORPUS_CASES,
  CorpusError,
  auditDocument,
  auditFixture,
  readFixture,
  projectPath,
  summarizeResult,
  surveyDocument,
} from "./corpus.ts";

it.layer(NodeFileSystem.layer)("Pinned first-party corpus", (it) => {
  it.effect("accounts for every public fixture, license and notice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* fs.readDirectory(projectPath("fixtures"));
      const expected = new Set([
        ...CORPUS.flatMap((source) => [
          source.file,
          source.licenseFile,
          ...(source.notices ?? []).map((notice) => notice.file),
        ]),
        "sources.json",
        "corpus-baseline.json",
        "json-schema",
        "client-evaluation",
      ]);
      expect(files.sort()).toEqual([...expected].sort());
    }),
  );
  it.effect.each(CORPUS_CASES)(
    "audits $source.name ($parameterProfile) without network access",
    ({ source, parameterProfile }) =>
      Effect.gen(function* () {
        const run = yield* auditFixture(source, parameterProfile);
        const baseline = BASELINE.find(
          (row) =>
            row.file === source.file &&
            row.parameterProfile === parameterProfile,
        );
        expect(
          baseline,
          "Each profile case needs an approved result",
        ).toBeDefined();
        expect(summarizeResult(run.result)).toEqual(baseline?.result);
        expect(source.url).toContain(`/${source.commit}/`);
        expect(source.licenseUrl).toContain(`/${source.commit}/`);
        if (run.result.status === "compiled") {
          expect(run.result.problems).toEqual([]);
          expect(run.result.exportFailures).toEqual([]);
          expect(run.result.tools.length).toBeGreaterThan(0);
        }
      }),
    30_000,
  );
  it.effect("fails fixture integrity before accepting changed content", () =>
    Effect.gen(function* () {
      const source = CORPUS.find((s) => s.name === "Petstore");
      expect(source).toBeDefined();
      if (source === undefined) throw new Error("Missing fixture");
      const failure = yield* Effect.flip(
        readFixture({ ...source, sha256: "0".repeat(64) }),
      );
      expect(failure).toBeInstanceOf(CorpusError);
      expect(failure.message).toContain("hash mismatch");
    }),
  );
  it.effect("rejects a changed additional upstream notice", () =>
    Effect.gen(function* () {
      const source = CORPUS.find((s) => s.name === "Docker Engine");
      const notice = source?.notices?.at(-1);
      if (source === undefined || notice === undefined)
        throw new Error("Missing Docker notice");
      const failure = yield* Effect.flip(
        readFixture({
          ...source,
          notices: (source.notices ?? []).map((entry) =>
            entry === notice ? { ...entry, sha256: "0".repeat(64) } : entry,
          ),
        }),
      );
      expect(failure).toBeInstanceOf(CorpusError);
      expect(failure.message).toContain(`${notice.file} hash mismatch`);
    }),
  );
});
it("requires a unique, complete baseline and corpus manifest", () => {
  expect(new Set(CORPUS.map((s) => s.file)).size).toBe(CORPUS.length);
  const cases = CORPUS_CASES.map(
    ({ source, parameterProfile }) => `${source.file}:${parameterProfile}`,
  );
  expect(new Set(cases).size).toBe(CORPUS_CASES.length);
  expect(
    BASELINE.map((row) => `${row.file}:${row.parameterProfile}`).sort(),
  ).toEqual(cases.sort());
  expect(
    CORPUS_CASES.filter((entry) => entry.parameterProfile === "spec").map(
      (entry) => entry.source,
    ),
  ).toEqual(CORPUS);
});
it("audits default bracket encoding and explicit strict encoding separately", () => {
  const document = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/search": {
        get: {
          parameters: [
            {
              in: "query",
              name: "filter",
              style: "deepObject",
              explode: true,
              schema: {
                type: "object",
                properties: {
                  tags: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
          ],
          responses: { "200": { content: { "application/json": {} } } },
        },
      },
    },
  });
  expect(auditDocument(document, "spec").result.status).toBe(
    "compile-rejected",
  );
  const profiled = auditDocument(document).result;
  expect(profiled.status).toBe("compiled");
  if (profiled.status !== "compiled")
    throw new Error("Expected profiled catalog");
  expect(profiled.survey.operations).toHaveLength(1);
  expect(profiled.tools).toHaveLength(1);
  expect(profiled.unsupported).toEqual([]);
  expect(profiled.exportFailures).toEqual([]);
  expect(profiled.problems).toEqual([]);
});
it("counts custom methods and unresolved declarations before subset decoding", () => {
  const survey = surveyDocument({
    openapi: "3.2.0",
    paths: {
      "/items": {
        get: { $ref: "resources/list.yaml" },
        additionalOperations: {
          COPY: {
            callbacks: { done: { $ref: "#/components/callbacks/Done" } },
          },
        },
      },
      "/other": { $ref: "paths/other.yaml" },
    },
    webhooks: { created: { $ref: "webhooks.yaml" } },
  });
  expect(survey.operations).toEqual([
    { method: "COPY", path: "/items" },
    { method: "get", path: "/items" },
  ]);
  expect(survey.referencedOperations).toBe(1);
  expect(survey.referencedPathItems).toBe(1);
  expect(survey.externalReferenceStrings).toBe(3);
  expect(survey.webhooks).toBe(1);
  expect(survey.callbacks).toBe(1);
});
it.each([
  '{"openapi":"3.1.0","openapi":"3.2.0","paths":{}}',
  "openapi: 3.1.0\npaths: &p { /x: *p }",
])("uses production parser restrictions (%s)", (text) => {
  expect(auditDocument(text).result.status).toBe("parse-rejected");
});
it("reports legacy rejection as a compiler failure rather than zero-tool coverage", () => {
  const run = auditDocument('{"swagger":"2.0","paths":{"/items":{"get":{}}}}');
  expect(run.result.status).toBe("compile-rejected");
  if (run.result.status !== "compile-rejected")
    throw new Error("Expected rejection");
  expect(run.result.survey.operations).toHaveLength(1);
  expect(run.result.reason).toContain("Swagger documents are not supported");
  expect(run.timings.exportMs).toBeNull();
});

it("fingerprints wire contracts independently of input schemas", () => {
  const run = (explode: boolean) =>
    auditDocument(
      JSON.stringify({
        openapi: "3.1.2",
        paths: {
          "/values": {
            get: {
              parameters: [
                {
                  in: "query",
                  name: "values",
                  explode,
                  schema: { type: "array", items: { type: "string" } },
                },
              ],
              responses: { "200": { content: { "application/json": {} } } },
            },
          },
        },
      }),
    ).result;
  const repeated = run(true);
  const delimited = run(false);
  if (repeated.status !== "compiled" || delimited.status !== "compiled")
    throw new Error("Expected compiled catalogs");
  expect(repeated.tools[0]?.inputSha256).toBe(delimited.tools[0]?.inputSha256);
  expect(repeated.tools[0]?.wireSha256).not.toBe(
    delimited.tools[0]?.wireSha256,
  );
  expect(summarizeResult(repeated)).not.toEqual(summarizeResult(delimited));
});
