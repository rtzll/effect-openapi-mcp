import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import BASELINE from "../fixtures/corpus-baseline.json" with { type: "json" };
import { auditDocument, CORPUS, readFixture } from "../scripts/corpus.ts";
import { parseOpenApi } from "./catalog.ts";
import { bundleOpenApi } from "./references.ts";

const compiledFiles = new Set(
  BASELINE.filter((entry) => entry.result.status === "compiled").map(
    (entry) => entry.file,
  ),
);

it.effect.each(CORPUS.filter((source) => compiledFiles.has(source.file)))(
  "preserves the complete public catalog through default reference resolution: $name",
  (source) =>
    Effect.gen(function* () {
      const fixture = yield* readFixture(source);
      const assembled = yield* bundleOpenApi(
        parseOpenApi(fixture.text),
        new URL(source.url),
        () =>
          Effect.die("Default reference resolution must not fetch documents"),
        { mode: "none", maxDocuments: 128, maxDepth: 64 },
      );
      const expected = auditDocument(fixture.text).result;
      expect(expected.status).toBe("compiled");
      expect(auditDocument(JSON.stringify(assembled)).result).toEqual(expected);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  30_000,
);
