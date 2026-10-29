import { describe, expect, it } from "@effect/vitest";
import {
  Arbitrary,
  Effect,
  Result,
  Schema,
  SchemaRepresentation,
} from "effect";
import { compileOpenApi } from "./openapi.ts";
import type { JsonObject, JsonValue } from "./openapi-types.ts";
import { API_RESPONSES, findOperation } from "./test-fixtures.ts";

// Seeds are stable per property and OpenAPI version; each property runs 160 generated cases.
// Native shrinking remains enabled. To reproduce a minimized failure, copy the printed
// replay token into arbitrary.replay below; it supersedes the seed and run count.
const options = (property: string, version: string) => ({
  arbitrary: {
    seed: `schema-properties-v1:${property}:${version}`,
    runs: 160,
    size: 8,
    maxShrinks: 500,
  },
});
const STRICT = { onExcessProperty: "error" } as const;

const operationFor = (schema: JsonObject, openapi: string) =>
  findOperation(
    compileOpenApi({
      openapi,
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/values": {
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema } },
            },
            responses: API_RESPONSES,
          },
        },
      },
    }),
    "post_values",
  );

// Independent JSON equality oracle: arrays retain order, object keys are sorted,
// and JSON's primitive representation distinguishes numbers, strings, booleans and null.
const canonical = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
};
const reverseKeys = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reverseKeys);
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseKeys(child)]),
  );
};
const json = Arbitrary.schema(Schema.MutableJson);
const arrays = Arbitrary.all({
  values: Arbitrary.array(json, { minLength: 1, maxLength: 8 }),
  duplicate: Arbitrary.schema(Schema.Boolean),
}).pipe(
  Arbitrary.map(({ values, duplicate }) => {
    const first = values[0];
    if (first === undefined)
      throw new Error("Expected a nonempty generated array.");
    return duplicate ? [...values, reverseKeys(first)] : values;
  }),
);
const objects = Arbitrary.schema(
  Schema.Struct({
    first: Schema.MutableJson,
    second: Schema.MutableJson,
    nested: Schema.Array(Schema.MutableJson)
      .pipe(Schema.mutable)
      .check(Schema.isMaxLength(4)),
  }),
);
const bodySchema: JsonObject = {
  type: "object",
  required: ["id", "label", "state", "values", "metadata"],
  properties: {
    id: { type: "integer", minimum: 1, maximum: 64 },
    label: { type: "string", minLength: 2, maxLength: 12 },
    state: { type: "string", enum: ["ready", "pending"] },
    values: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: { type: "integer", minimum: 0, maximum: 32 },
    },
    metadata: { type: "string", readOnly: true, default: "server-default" },
  },
  additionalProperties: true,
};
const bodyOf = (input: unknown) =>
  Schema.decodeUnknownSync(
    Schema.Struct({ body: Schema.Record(Schema.String, Schema.MutableJson) }),
  )(input).body;
const mutations = (body: JsonObject): ReadonlyArray<unknown> => {
  const missing = { ...body };
  delete missing.id;
  return [
    { body: missing },
    { body: { ...body, id: 0 } },
    { body: { ...body, id: 65 } },
    { body: { ...body, id: 1.5 } },
    { body: { ...body, label: "" } },
    { body: { ...body, label: "x".repeat(13) } },
    { body: { ...body, state: "unknown" } },
    { body: { ...body, values: [] } },
    { body: { ...body, values: [0, 1, 2, 3, 4, 5] } },
    { body: { ...body, values: [1, 1] } },
    { body: { ...body, values: [33] } },
    { body: { ...body, values: ["1"] } },
    { body: { ...body, metadata: 17 } },
    { body, unexpectedEnvelopeField: true },
  ];
};

describe.each(["3.0.4", "3.1.2", "3.2.1"])(
  "Generated native schema semantics (%s)",
  (version) => {
    const unique = operationFor(
      { type: "array", items: {}, uniqueItems: true },
      version,
    ).parametersSchema;
    const original = operationFor(bodySchema, version).parametersSchema;
    // Both native export and decoding must request strict excess-property behavior.
    const exported = Schema.toJsonSchemaDocument(original, STRICT);
    const reimported = Schema.make<Schema.Codec<unknown>>(
      SchemaRepresentation.fromJsonSchemaDocument(exported).ast,
    );
    // Generate the imported contract's encoded domain, not the broader decoded envelope.
    const inputs = Arbitrary.schema(Schema.toEncoded(original));

    it.prop(
      "agrees with an independent structural JSON uniqueness oracle",
      { values: arrays },
      ({ values }) => {
        const expected = new Set(values.map(canonical)).size === values.length;
        const actual = Schema.decodeResult(unique, STRICT)({ body: values });
        expect(Result.isSuccess(actual)).toBe(expected);
      },
      options("uniqueness", version),
    );

    it.prop(
      "ignores object key order while retaining distinct additional data",
      { object: objects },
      ({ object }) => {
        const reordered = reverseKeys(object);
        expect(canonical(reordered)).toBe(canonical(object));
        expect(
          Result.isFailure(
            Schema.decodeResult(unique, STRICT)({ body: [object, reordered] }),
          ),
        ).toBe(true);
        const distinct = { ...object, additional: false };
        expect(canonical(distinct)).not.toBe(canonical(object));
        expect(
          Result.isSuccess(
            Schema.decodeResult(unique, STRICT)({ body: [object, distinct] }),
          ),
        ).toBe(true);
      },
      options("property-order", version),
    );

    it.effect.prop(
      "preserves generated contracts, additional data and readOnly/default semantics through export",
      { input: inputs, additional: json },
      ({ input, additional }) =>
        Effect.gen(function* () {
          yield* Schema.decodeUnknownEffect(original, STRICT)(input);
          const body: JsonObject = { ...bodyOf(input), additional };
          delete body.metadata;
          const argument = { body };
          const decoded = yield* Schema.decodeEffect(
            original,
            STRICT,
          )(argument);
          const afterExport = yield* Schema.decodeEffect(
            reimported,
            STRICT,
          )(argument);
          expect(decoded).toEqual(argument);
          expect(afterExport).toEqual(argument);
          expect(bodyOf(afterExport)).not.toHaveProperty("metadata");
          expect(
            yield* Schema.decodeEffect(
              reimported,
              STRICT,
            )({
              body: reverseKeys(body),
            }),
          ).toEqual({ body: reverseKeys(body) });
        }),
      options("export-roundtrip", version),
    );

    it.effect.prop(
      "rejects generated invalid mutations with native typed failures before and after export",
      { input: inputs },
      ({ input }) =>
        Effect.gen(function* () {
          yield* Schema.decodeUnknownEffect(original, STRICT)(input);
          for (const invalid of mutations(bodyOf(input))) {
            for (const codec of [original, reimported]) {
              const result = yield* Effect.result(
                Schema.decodeUnknownEffect(codec, STRICT)(invalid),
              );
              expect(
                Result.isFailure(result) &&
                  Schema.isSchemaError(result.failure),
              ).toBe(true);
            }
          }
        }),
      options("invalid-mutations", version),
    );
  },
);
