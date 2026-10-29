import { describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import { compileOpenApi } from "./openapi.ts";
import { API_RESPONSES, accepts, findOperation } from "./test-fixtures.ts";

const cat = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "lives"],
  properties: {
    kind: { type: "string", enum: ["cat"] },
    lives: { type: "integer", minimum: 1 },
  },
};
const dog = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "bark"],
  properties: {
    kind: { type: "string", enum: ["dog"] },
    bark: { type: "boolean" },
  },
};
const compile = (schema: unknown, version = "3.1.2") =>
  compileOpenApi({
    openapi: version,
    servers: [{ url: "https://polymorphic.example.com" }],
    components: { schemas: { Cat: cat, Dog: dog } },
    paths: {
      "/health": { get: { responses: API_RESPONSES } },
      "/pets": {
        post: {
          operationId: "pet",
          requestBody: {
            required: true,
            content: { "application/json": { schema } },
          },
          responses: API_RESPONSES,
        },
      },
    },
  });
describe("OpenAPI discriminator annotations", () => {
  it.each(["3.0.4", "3.1.2", "3.2.1"])(
    "retains native oneOf validation in %s without trusting mapping hints",
    (version) => {
      const operation = findOperation(
        compile(
          {
            oneOf: [
              { $ref: "#/components/schemas/Cat" },
              { $ref: "#/components/schemas/Dog" },
            ],
            discriminator: {
              propertyName: "kind",
              mapping: {
                cat: "#/components/schemas/Dog",
                dog: "https://unused.example.com/external.json",
              },
            },
          },
          version,
        ),
        "pet",
      );
      expect(accepts(operation, { body: { kind: "cat", lives: 9 } })).toBe(
        true,
      );
      expect(accepts(operation, { body: { kind: "dog", bark: false } })).toBe(
        true,
      );
      expect(accepts(operation, { body: { kind: "cat", bark: true } })).toBe(
        false,
      );
      expect(accepts(operation, { body: { kind: "cat", lives: 0 } })).toBe(
        false,
      );
      expect(
        accepts(operation, { body: { kind: "unknown", bark: true } }),
      ).toBe(false);
      const schema = Tool.getJsonSchema(
        Tool.dynamic(operation.name, {
          parameters: operation.parametersSchema,
        }),
      );
      expect(JSON.stringify(schema)).not.toContain("unused.example.com");
      expect(schema.properties).toHaveProperty("body");
    },
  );
  it("does not search child schemas for an allOf parent's discriminator", () => {
    const operation = findOperation(
      compile({
        allOf: [
          {
            type: "object",
            properties: { kind: { type: "string" } },
            required: ["kind"],
          },
        ],
        discriminator: {
          propertyName: "kind",
          mapping: { cat: "#/components/schemas/Cat" },
        },
      }),
      "pet",
    );
    expect(accepts(operation, { body: { kind: "cat" } })).toBe(true);
    expect(accepts(operation, { body: {} })).toBe(false);
  });
  it("preserves optional-property validation with a 3.2 defaultMapping hint", () => {
    const operation = findOperation(
      compile(
        {
          oneOf: [
            cat,
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["other"] },
                note: { type: "string" },
              },
              required: ["note"],
            },
          ],
          discriminator: {
            propertyName: "kind",
            mapping: { cat: "Cat" },
            defaultMapping: "Other",
          },
        },
        "3.2.1",
      ),
      "pet",
    );
    expect(
      accepts(operation, { body: { note: "without discriminator value" } }),
    ).toBe(true);
    expect(accepts(operation, { body: { kind: "cat", lives: 9 } })).toBe(true);
    expect(
      accepts(operation, {
        body: { kind: "unknown", note: "no matching branch" },
      }),
    ).toBe(false);
  });
  it("still rejects values matching multiple oneOf branches", () => {
    const operation = findOperation(
      compile({
        oneOf: [
          {
            type: "object",
            properties: { a: { type: "integer" } },
            required: ["a"],
          },
          {
            type: "object",
            properties: { b: { type: "integer" } },
            required: ["b"],
          },
        ],
        discriminator: { propertyName: "kind", mapping: { first: "First" } },
      }),
      "pet",
    );
    expect(accepts(operation, { body: { kind: "first", a: 1, b: 2 } })).toBe(
      false,
    );
    expect(accepts(operation, { body: { kind: "first", a: 1 } })).toBe(true);
  });
  it.each([
    null,
    {},
    { propertyName: 1 },
    { propertyName: "kind", mapping: { cat: 1 } },
    { propertyName: "kind", defaultMapping: false },
  ])("diagnoses malformed discriminator metadata", (discriminator) => {
    expect(compile({ oneOf: [cat, dog], discriminator }).unsupported).toEqual([
      {
        method: "post",
        path: "/pets",
        reason:
          "Unsupported input schema: Invalid OpenAPI discriminator annotation.",
      },
    ]);
  });
});
