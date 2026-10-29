import { createHash } from "node:crypto";
import { Redacted } from "effect";
import { Tool } from "effect/ai";
import { describe, expect, it } from "@effect/vitest";
import SOURCES from "../fixtures/sources.json" with { type: "json" };
import { compileOpenApi } from "./openapi.ts";
import { PUBLIC_SPECS, readPublicSpec } from "./public-fixtures.ts";
import { HTTP_METHODS } from "./openapi-types.ts";

const EXPOSED = {
  "petstore-3.0.yaml": 18,
  "github-3.0.json.gz": 1229,
  "github-3.1.json.gz": 1229,
  "oai-query-3.2.yaml": 1,
  "oai-tags-3.2.yaml": 4,
} satisfies Record<(typeof PUBLIC_SPECS)[number], number>;

describe("Pinned public API compatibility", () => {
  it.each(PUBLIC_SPECS)(
    "accounts for every operation in %s",
    (file) => {
      const { stored, contents, document } = readPublicSpec(file);
      const source = SOURCES.find((source) => source.file === file);
      expect(createHash("sha256").update(contents).digest("hex")).toBe(
        source?.sha256,
      );
      expect(createHash("sha256").update(stored).digest("hex")).toBe(
        source?.storedSha256,
      );
      const credentials = Object.fromEntries(
        Object.keys(document.components.securitySchemes).map((name) => [
          name,
          Redacted.make("public-fixture-token"),
        ]),
      );
      const catalog = compileOpenApi(document, {
        credentials,
        baseUrl: new URL("https://mock.example.com/v1/"),
      });
      const declared = Object.values(document.paths).reduce(
        (count, path) =>
          count +
          HTTP_METHODS.filter((method) => path[method] !== undefined).length,
        0,
      );
      expect(catalog.filtered).toEqual([]);
      expect(catalog.operations.length + catalog.unsupported.length).toBe(
        declared,
      );
      expect(catalog.operations).toHaveLength(EXPOSED[file]);
      expect(catalog.unsupported).toMatchSnapshot();
      expect(
        new Set(catalog.operations.map((operation) => operation.name)).size,
      ).toBe(catalog.operations.length);
      for (const operation of catalog.operations) {
        expect(operation.name).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
        const schema = Tool.getJsonSchema(
          Tool.dynamic(operation.name, {
            parameters: operation.parametersSchema,
          }),
        );
        expect(schema.type).toBe("object");
        expect(JSON.stringify(schema)).not.toContain("public-fixture-token");
      }
    },
    30_000,
  );
});
