import { describe, expect, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Redacted } from "effect";
import { Tool } from "effect/ai";
import { CORPUS, readFixture } from "../scripts/corpus.ts";
import { parseOpenApi } from "./catalog.ts";
import { compileOpenApi } from "./openapi.ts";
import { accepts, findOperation } from "./test-fixtures.ts";
import type { JsonObject, JsonValue } from "./openapi-types.ts";

const operationFor = (schema: unknown, components: object = {}) =>
  findOperation(
    compileOpenApi({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      components: { schemas: components },
      paths: {
        "/items": {
          post: {
            operationId: "submit",
            requestBody: {
              required: true,
              content: { "application/json": { schema } },
            },
            responses: { "204": {} },
          },
        },
      },
    }),
    "submit",
  );
const threshold = (mode: "anyOf" | "oneOf") => ({
  type: "object",
  additionalProperties: false,
  required: ["operator"],
  properties: {
    operator: { enum: ["above", "below"] },
    warning: { type: "number", minimum: 0 },
    critical: { type: "number", minimum: 0 },
  },
  [mode]: [{ required: ["warning"] }, { required: ["critical"] }],
});
const at = (value: JsonValue, ...keys: string[]): JsonValue => {
  let current = value;
  for (const key of keys) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    )
      throw new Error(`Missing fixture field: ${key}`);
    const child = current[key];
    if (child === undefined) throw new Error(`Missing fixture field: ${key}`);
    current = child;
  }
  return current;
};
const record = (value: JsonValue): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected fixture object.");
  return value;
};

describe("Bounded schema composition", () => {
  it.each(["anyOf", "oneOf"] as const)(
    "preserves %s alternatives and every sibling constraint",
    (mode) => {
      const operation = operationFor(threshold(mode));
      expect(
        accepts(operation, { body: { operator: "above", warning: 1 } }),
      ).toBe(true);
      expect(
        accepts(operation, { body: { operator: "below", critical: 2 } }),
      ).toBe(true);
      expect(
        accepts(operation, {
          body: { operator: "above", warning: 1, critical: 2 },
        }),
      ).toBe(mode === "anyOf");
      for (const body of [
        { operator: "above" },
        { warning: 1 },
        { operator: "invalid", warning: 1 },
        { operator: "above", warning: -1 },
        { operator: "above", warning: "1" },
        { operator: "above", warning: 1, extra: true },
      ])
        expect(accepts(operation, { body })).toBe(false);
      const exported = Tool.getJsonSchema(
        Tool.dynamic(operation.name, {
          parameters: operation.parametersSchema,
        }),
      );
      expect(JSON.stringify(exported)).toContain(mode);
    },
  );
  it("retains mixed anyOf and oneOf grouping and duplicate oneOf alternatives", () => {
    const operation = operationFor({
      type: "object",
      properties: {
        a: { type: "boolean" },
        b: { type: "boolean" },
        x: { type: "boolean" },
        y: { type: "boolean" },
      },
      allOf: [
        { anyOf: [{ required: ["a"] }, { required: ["b"] }] },
        { oneOf: [{ required: ["x"] }, { required: ["y"] }] },
      ],
    });
    expect(accepts(operation, { body: { a: true, b: true, x: true } })).toBe(
      true,
    );
    expect(accepts(operation, { body: { b: true, y: true } })).toBe(true);
    expect(accepts(operation, { body: { a: true, x: true, y: true } })).toBe(
      false,
    );
    expect(accepts(operation, { body: { x: true } })).toBe(false);
    const duplicate = operationFor({
      type: "object",
      properties: { a: { type: "boolean" } },
      oneOf: [{ required: ["a"] }, { required: ["a"] }],
    });
    expect(accepts(duplicate, { body: { a: true } })).toBe(false);
    expect(accepts(duplicate, { body: {} })).toBe(false);
  });
  it("does not invent an object type for untyped object keywords", () => {
    const operation = operationFor({
      allOf: [
        { properties: { value: { type: "string" } } },
        { required: ["value"] },
      ],
    });
    for (const body of [null, true, 3, "text", []])
      expect(accepts(operation, { body })).toBe(true);
    expect(accepts(operation, { body: {} })).toBe(false);
    expect(accepts(operation, { body: { value: 3 } })).toBe(false);
    expect(accepts(operation, { body: { value: "ok" } })).toBe(true);
  });
  it("preserves closed-object scope across object intersections", () => {
    const operation = operationFor({
      allOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: { a: { type: "string" } },
        },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    });
    expect(accepts(operation, { body: { a: "ok" } })).toBe(true);
    expect(accepts(operation, { body: { a: "ok", b: 1 } })).toBe(false);
    expect(accepts(operation, { body: { a: 1 } })).toBe(false);
    expect(() =>
      operationFor({
        allOf: [
          {
            type: "object",
            additionalProperties: { type: "string" },
            properties: { a: { type: "string" } },
          },
          { type: "object", properties: { b: { type: "number" } } },
        ],
      }),
    ).toThrow(/additionalProperties/);
  });
  it("keeps required unknown properties and projects inherited read-only properties", () => {
    const operation = operationFor(
      {
        allOf: [
          {
            type: "object",
            properties: {
              name: { type: "string" },
              id: {
                allOf: [
                  { $ref: "#/components/schemas/ServerId" },
                  { readOnly: false },
                ],
              },
            },
          },
          { type: "object", required: ["name", "id", "unknown"] },
        ],
      },
      { ServerId: { type: "string", readOnly: true } },
    );
    expect(
      accepts(operation, {
        body: { name: "ok", unknown: { arbitrary: true } },
      }),
    ).toBe(true);
    expect(accepts(operation, { body: { name: "ok" } })).toBe(false);
    expect(
      accepts(operation, { body: { name: "ok", unknown: null, id: 7 } }),
    ).toBe(false);
  });
  it("deduplicates conjunction references without unfolding recursive properties", () => {
    const operation = operationFor(
      {
        allOf: [
          { $ref: "#/components/schemas/Node" },
          {
            allOf: [
              { $ref: "#/components/schemas/Node" },
              { type: "object", required: ["label"] },
            ],
          },
        ],
      },
      {
        Node: {
          type: "object",
          properties: {
            label: { type: "string" },
            next: { $ref: "#/components/schemas/Node" },
            kind: { enum: ["a", "b"] },
          },
        },
      },
    );
    expect(
      accepts(operation, {
        body: { label: "root", next: { label: "child", kind: "a" } },
      }),
    ).toBe(true);
    expect(accepts(operation, { body: { next: { label: "child" } } })).toBe(
      false,
    );
    expect(
      accepts(operation, {
        body: { label: "root", next: { kind: "invalid" } },
      }),
    ).toBe(false);
  });
  it("preserves native rejection of references under nested schema resources", () => {
    expect(() =>
      operationFor(
        {
          type: "object",
          properties: {
            scope: {
              $id: "https://example.com/scope",
              type: "object",
              properties: {
                inner: {
                  allOf: [
                    { $ref: "#/$defs/A" },
                    { type: "object", required: ["x"] },
                  ],
                },
              },
            },
          },
        },
        { A: { type: "object", properties: { x: { type: "string" } } } },
      ),
    ).toThrow(/nested.*\$id/);
  });
  it("leaves recursive intersections to native reference validation", () => {
    expect(() =>
      operationFor(
        { $ref: "#/components/schemas/Node" },
        {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              child: {
                allOf: [
                  { $ref: "#/components/schemas/Node" },
                  { type: "object", required: ["name"] },
                ],
              },
            },
          },
        },
      ),
    ).toThrow(/circular alias/);
  });
  it("bounds repeated inlining in acyclic reference graphs", () => {
    const components: Record<string, JsonObject> = {
      Node0: { type: "object", properties: { name: { type: "string" } } },
    };
    for (let depth = 1; depth <= 10; depth++) {
      const child: JsonObject = {
        allOf: [
          { $ref: `#/components/schemas/Node${depth - 1}` },
          { type: "object", required: ["name"] },
        ],
      };
      components[`Node${depth}`] = {
        type: "object",
        properties: { name: { type: "string" }, left: child, right: child },
      };
    }
    expect(() =>
      operationFor({ $ref: "#/components/schemas/Node10" }, components),
    ).toThrow(/reference expansion limit/);
  });
  it("rejects expansion beyond the operation budget and resets it for the next operation", () => {
    const choices = Array.from({ length: 20 }, (_, index) => ({
      required: [`field${index}`],
    }));
    expect(() =>
      operationFor({
        type: "object",
        allOf: [{ anyOf: choices }, { anyOf: choices }],
      }),
    ).toThrow(/branch expansion limit/);
    expect(
      accepts(operationFor(threshold("anyOf")), {
        body: { operator: "above", warning: 1 },
      }),
    ).toBe(true);
  });
  it.effect(
    "validates the six restored DigitalOcean firewall and alert operations",
    () =>
      Effect.gen(function* () {
        const source = CORPUS.find(
          (source) => source.file === "digitalocean-bundled.yaml.gz",
        );
        if (source === undefined)
          throw new Error("Missing DigitalOcean fixture.");
        const fixture = yield* readFixture(source);
        const document = parseOpenApi(fixture.text);
        const catalog = compileOpenApi(document, {
          baseUrl: new URL("https://api.example.com"),
          credentials: { bearer_auth: Redacted.make("fixture-token") },
        });
        const samples = [
          ["post", "/v2/firewalls"],
          ["put", "/v2/firewalls/{firewall_id}"],
          ["post", "/v2/firewalls/{firewall_id}/rules"],
          ["delete", "/v2/firewalls/{firewall_id}/rules"],
          ["post", "/v2/insights/alert-rules"],
          ["put", "/v2/insights/alert-rules/{id}"],
        ] as const;
        const alertExample = record(
          at(
            document,
            "paths",
            "/v2/insights/alert-rules",
            "post",
            "requestBody",
            "content",
            "application/json",
            "example",
          ),
        );
        for (const [method, path] of samples) {
          const operation = catalog.operations.find(
            (operation) =>
              operation.method === method && operation.path === path,
          );
          if (operation === undefined)
            throw new Error(`Missing restored operation ${method} ${path}`);
          const pathArguments = Object.fromEntries(
            operation.parameters
              .filter((parameter) => parameter.location === "path")
              .map((parameter) => [
                parameter.name,
                "550e8400-e29b-41d4-a716-446655440000",
              ]),
          );
          const argumentsFor = (body: JsonValue) => ({
            ...(Object.keys(pathArguments).length === 0
              ? {}
              : { path: pathArguments }),
            body,
          });
          if (path.includes("firewalls")) {
            const base: JsonObject = path.endsWith("/rules")
              ? {}
              : { name: "example" };
            expect(
              accepts(operation, argumentsFor({ ...base, inbound_rules: [] })),
            ).toBe(true);
            expect(
              accepts(operation, argumentsFor({ ...base, outbound_rules: [] })),
            ).toBe(true);
            expect(
              accepts(
                operation,
                argumentsFor({
                  ...base,
                  inbound_rules: [],
                  outbound_rules: [],
                }),
              ),
            ).toBe(true);
            expect(accepts(operation, argumentsFor(base))).toBe(false);
            expect(
              accepts(
                operation,
                argumentsFor({ ...base, inbound_rules: "wrong" }),
              ),
            ).toBe(false);
          } else {
            const spec = record(at(alertExample, "spec"));
            const threshold = record(at(spec, "thresholds"));
            const withoutBoth = { ...threshold };
            delete withoutBoth.warning;
            delete withoutBoth.critical;
            const thresholdAlternatives: JsonObject[] = [
              { warning: 80 },
              { critical: 95 },
              { warning: 80, critical: 95 },
            ];
            for (const fields of thresholdAlternatives)
              expect(
                accepts(
                  operation,
                  argumentsFor({
                    ...alertExample,
                    spec: {
                      ...spec,
                      thresholds: { ...withoutBoth, ...fields },
                    },
                  }),
                ),
              ).toBe(true);
            expect(
              accepts(
                operation,
                argumentsFor({
                  ...alertExample,
                  spec: { ...spec, thresholds: withoutBoth },
                }),
              ),
            ).toBe(false);
            expect(
              accepts(
                operation,
                argumentsFor({
                  ...alertExample,
                  spec: {
                    ...spec,
                    thresholds: { ...threshold, warning: "wrong" },
                  },
                }),
              ),
            ).toBe(false);
            const withoutChannels = { ...spec };
            delete withoutChannels.notification_channels;
            expect(
              accepts(
                operation,
                argumentsFor({ ...alertExample, spec: withoutChannels }),
              ),
            ).toBe(method === "put");
          }
          expect(
            Tool.getJsonSchema(
              Tool.dynamic(operation.name, {
                parameters: operation.parametersSchema,
              }),
            ).type,
          ).toBe("object");
        }
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
