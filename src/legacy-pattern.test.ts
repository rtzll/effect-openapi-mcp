import { describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import { normalizeLegacyPattern } from "./legacy-pattern.ts";
import { compileOpenApi } from "./openapi.ts";
import { accepts, API_RESPONSES, findOperation } from "./test-fixtures.ts";

const compile = (pattern: string, openapi = "3.0.4") =>
  compileOpenApi({
    openapi,
    servers: [{ url: "https://api.example.com" }],
    components: {
      schemas: { Tag: { type: "string", pattern, maxLength: 255 } },
    },
    paths: {
      "/tags/{tag}": {
        get: {
          operationId: "tag",
          parameters: [
            {
              name: "tag",
              in: "path",
              required: true,
              schema: { $ref: "#/components/schemas/Tag" },
            },
          ],
          responses: API_RESPONSES,
        },
      },
    },
  });

describe("OpenAPI 3.0 punctuation identity escapes", () => {
  it("imports and exports DigitalOcean's tag pattern with the same constraints", () => {
    const operation = findOperation(
      compile(String.raw`^[a-zA-Z0-9_\-\:]+$`),
      "tag",
    );
    const inputSchema = Tool.getJsonSchema(
      Tool.dynamic(operation.name, { parameters: operation.parametersSchema }),
    );
    expect(inputSchema).toHaveProperty(
      "properties.path.properties.tag.$ref",
      "#/$defs/Tag",
    );
    expect(inputSchema).toHaveProperty(
      "$defs.Tag.pattern",
      String.raw`^[a-zA-Z0-9_\x2d\x3a]+$`,
    );
    expect(inputSchema).toHaveProperty("$defs.Tag.maxLength", 255);
    for (const tag of ["extra-awesome", "ENV:prod_1", "a".repeat(255)]) {
      expect(accepts(operation, { path: { tag } })).toBe(true);
    }
    for (const tag of ["", "a b", "a/b", "é", "😀", "a".repeat(256)]) {
      expect(accepts(operation, { path: { tag } })).toBe(false);
    }
  });

  it.each(["3.1.2", "3.2.1"])(
    "keeps Unicode-incompatible identity escapes rejected in %s",
    (version) => {
      expect(() => compile(String.raw`^[a-zA-Z0-9_\-\:]+$`, version)).toThrow(
        "Invalid escape",
      );
    },
  );

  it.each([
    "!",
    '"',
    "#",
    "%",
    "&",
    "'",
    ",",
    "-",
    ":",
    ";",
    "<",
    "=",
    ">",
    "@",
    "`",
    "~",
  ])(
    "preserves literal %s inside and outside character classes",
    (punctuation) => {
      for (const pattern of [`^\\${punctuation}$`, `^[\\${punctuation}]+$`]) {
        const legacy = new RegExp(pattern);
        const unicode = new RegExp(normalizeLegacyPattern(pattern), "u");
        for (let code = 0; code < 128; code++) {
          const value = String.fromCharCode(code);
          expect(unicode.test(value)).toBe(legacy.test(value));
          expect(unicode.test(value.repeat(2))).toBe(
            legacy.test(value.repeat(2)),
          );
        }
      }
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    "preserves escape parity for %i backslashes before punctuation",
    (count) => {
      const pattern = `^${"\\".repeat(count)}:$`;
      const legacy = new RegExp(pattern);
      const unicode = new RegExp(normalizeLegacyPattern(pattern), "u");
      for (let slashes = 0; slashes < 5; slashes++) {
        for (const suffix of [":", "x3a", "", "x"]) {
          const value = "\\".repeat(slashes) + suffix;
          expect(unicode.test(value)).toBe(legacy.test(value));
        }
      }
    },
  );

  it.each([
    String.raw`^[\:-\~]+$`,
    String.raw`^[a\-z]+$`,
    String.raw`^\-?\d+(?:\.\d+)?$`,
  ])("preserves ranges, literal hyphens and syntax escapes (%s)", (pattern) => {
    const legacy = new RegExp(pattern);
    const unicode = new RegExp(normalizeLegacyPattern(pattern), "u");
    for (const value of [
      "a",
      "b",
      "z",
      "-",
      ":",
      ";",
      "~",
      "8",
      "-8",
      "8.5",
      "-8.5",
      "",
      "😀",
    ]) {
      expect(unicode.test(value)).toBe(legacy.test(value));
    }
  });

  it.each(["[", "(", "a{2,1}", "[z-a]", "\\"])(
    "does not repair malformed regex syntax (%s)",
    (pattern) => {
      expect(() => normalizeLegacyPattern(pattern)).toThrow(SyntaxError);
      expect(() => compile(pattern)).toThrow("Unsupported input schema");
    },
  );

  it.each([
    String.raw`\q`,
    String.raw`\_`,
    String.raw`\8`,
    String.raw`\u{110000}`,
  ])(
    "does not normalize unsupported non-punctuation escapes (%s)",
    (pattern) => {
      expect(normalizeLegacyPattern(pattern)).toBe(pattern);
      expect(() => compile(pattern)).toThrow("Unsupported input schema");
    },
  );

  it("retains Unicode matching after normalizing punctuation", () => {
    const operation = findOperation(compile(String.raw`^\:.$`), "tag");
    expect(accepts(operation, { path: { tag: ":😀" } })).toBe(true);
    expect(accepts(operation, { path: { tag: ":😀😀" } })).toBe(false);
    expect(accepts(operation, { path: { tag: ":" } })).toBe(false);
  });
});
