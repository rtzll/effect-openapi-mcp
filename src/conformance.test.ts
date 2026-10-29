import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Result, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import SOURCES from "../fixtures/json-schema/sources.json" with { type: "json" };
import { JSON_SCHEMA } from "./openapi-types.ts";
import { compileOpenApi } from "./openapi.ts";
import { API_RESPONSES } from "./test-fixtures.ts";

describe("JSON Schema corpus provenance", () => {
  it("retains the license from the same pinned upstream revision", () => {
    const license = readFileSync(
      new URL(
        `../fixtures/json-schema/${SOURCES.licenseFile}`,
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(license).digest("hex")).toBe(
      SOURCES.licenseSha256,
    );
    expect(SOURCES.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(SOURCES.licenseUrl).toContain(`/${SOURCES.commit}/`);
    for (const source of SOURCES.fixtures) {
      expect(source.url).toContain(`/${SOURCES.commit}/`);
    }
  });

  it("accounts for every fixture and license without duplicate entries", () => {
    const files = SOURCES.fixtures.map((source) => source.file);
    expect(new Set(files).size).toBe(files.length);
    expect(
      readdirSync(new URL("../fixtures/json-schema/", import.meta.url)).sort(),
    ).toEqual([...files, SOURCES.licenseFile, "sources.json"].sort());
  });
});

const CORPUS = Schema.Array(
  Schema.Struct({
    description: Schema.String,
    schema: JSON_SCHEMA,
    tests: Schema.Array(
      Schema.Struct({
        description: Schema.String,
        data: Schema.MutableJson,
        valid: Schema.Boolean,
      }),
    ),
  }),
);
describe.each(["3.1.2", "3.2.1"])(
  "Official draft 2020-12 corpus (%s)",
  (openapi) => {
    const exclusions: Array<{
      file: string;
      description: string;
      reason: string;
    }> = [];
    let supportedGroups = 0;
    let supportedInstances = 0;
    let diagnosedInstances = 0;
    let uniqueGroups = 0;
    let uniqueInstances = 0;
    for (const source of SOURCES.fixtures) {
      const contents = readFileSync(
        new URL(`../fixtures/json-schema/${source.file}`, import.meta.url),
      );
      it(`verifies ${source.file} provenance`, () => {
        expect(createHash("sha256").update(contents).digest("hex")).toBe(
          source.sha256,
        );
      });
      const groups = Schema.decodeSync(Schema.fromJsonString(CORPUS))(
        contents.toString(),
      );
      for (const group of groups) {
        const catalog = compileOpenApi({
          openapi,
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/noop": { get: { responses: API_RESPONSES } },
            "/value": {
              post: {
                requestBody: {
                  required: true,
                  content: { "application/json": { schema: group.schema } },
                },
                responses: API_RESPONSES,
              },
            },
          },
        });
        const operation = catalog.operations.find(
          (operation) => operation.name === "post_value",
        );
        if (operation === undefined) {
          diagnosedInstances += group.tests.length;
          exclusions.push({
            file: source.file,
            description: group.description,
            reason:
              catalog.unsupported[0]?.reason ??
              "Missing operation without diagnostic",
          });
          continue;
        }
        supportedGroups += 1;
        supportedInstances += group.tests.length;
        if (source.file === "uniqueItems.json") {
          uniqueGroups += 1;
          uniqueInstances += group.tests.length;
          it(`${source.file}: ${group.description}: native schema export`, () => {
            const exported = Schema.toJsonSchemaDocument(
              operation.parametersSchema,
            );
            if (
              typeof group.schema === "object" &&
              group.schema.uniqueItems === true
            )
              expect(JSON.stringify(exported)).toContain('"uniqueItems":true');
          });
        }
        it.each(group.tests)(
          `${source.file}: ${group.description}: $description`,
          (test) => {
            const decoded = Schema.decodeResult(operation.parametersSchema, {
              onExcessProperty: "error",
            })({ body: test.data });
            expect(
              Result.isSuccess(decoded),
              Result.isFailure(decoded)
                ? decoded.failure.message
                : test.description,
            ).toBe(test.valid);
          },
        );
      }
    }
    it("records all diagnosed schema groups explicitly", () => {
      expect(exclusions).toMatchSnapshot();
      expect({
        supportedGroups,
        supportedInstances,
        diagnosedGroups: exclusions.length,
        diagnosedInstances,
      }).toMatchSnapshot();
    });
    it("supports every pinned official uniqueItems group", () => {
      expect({ uniqueGroups, uniqueInstances }).toEqual({
        uniqueGroups: 6,
        uniqueInstances: 69,
      });
    });
  },
);
