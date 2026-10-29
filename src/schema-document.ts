import { Result, Schema } from "effect";
import {
  JSON_SCHEMA,
  type JsonSchema,
  type JsonValue,
} from "./openapi-types.ts";

const MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "dependentSchemas",
]);
const ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SINGLE_KEYS = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "not",
  "contains",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
]);

export const schemaNode = (value: unknown): JsonSchema => {
  const decoded = Schema.decodeUnknownResult(JSON_SCHEMA)(value);
  if (Result.isFailure(decoded)) {
    throw new Error("Invalid nested schema.");
  }
  return decoded.success;
};

type SchemaVisitor = (
  node: Exclude<JsonSchema, boolean>,
) => Exclude<JsonSchema, boolean>;
export function mapSchema(
  schema: Exclude<JsonSchema, boolean>,
  visit: SchemaVisitor,
): Exclude<JsonSchema, boolean>;
export function mapSchema(schema: JsonSchema, visit: SchemaVisitor): JsonSchema;
export function mapSchema(
  schema: JsonSchema,
  visit: SchemaVisitor,
): JsonSchema {
  if (typeof schema === "boolean") {
    return schema;
  }
  const entries = Object.entries(schema).map(
    ([key, value]): [string, JsonValue] => {
      if (MAP_KEYS.has(key)) {
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value)
        ) {
          throw new Error(`Invalid schema map: ${key}`);
        }
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              mapSchema(schemaNode(child), visit),
            ]),
          ),
        ];
      }
      if (ARRAY_KEYS.has(key)) {
        if (!Array.isArray(value)) {
          throw new Error(`Invalid schema array: ${key}`);
        }
        return [key, value.map((child) => mapSchema(schemaNode(child), visit))];
      }
      if (SINGLE_KEYS.has(key)) {
        return [key, mapSchema(schemaNode(value), visit)];
      }
      return [key, value];
    },
  );
  return visit(Object.fromEntries(entries));
}

const TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "object",
  "array",
]);
const NON_NEGATIVE_INTEGER_KEYS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
]);
const NUMBER_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const BOOLEAN_KEYS = new Set([
  "uniqueItems",
  "readOnly",
  "writeOnly",
  "deprecated",
]);
const STRING_KEYS = new Set([
  "$ref",
  "$schema",
  "$id",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "title",
  "description",
  "pattern",
  "format",
  "contentEncoding",
  "contentMediaType",
]);

const DISCRIMINATOR_SCHEMA = Schema.Struct({
  propertyName: Schema.NonEmptyString,
  mapping: Schema.Record(Schema.String, Schema.String).pipe(Schema.optionalKey),
  defaultMapping: Schema.String.pipe(Schema.optionalKey),
});

export const validateSchemaNode = (
  node: Exclude<JsonSchema, boolean>,
): Exclude<JsonSchema, boolean> => {
  for (const [key, value] of Object.entries(node)) {
    let valid = true;
    if (NON_NEGATIVE_INTEGER_KEYS.has(key)) {
      valid =
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    } else if (NUMBER_KEYS.has(key)) {
      valid = typeof value === "number" && Number.isFinite(value);
      if (key === "multipleOf" && typeof value === "number") {
        valid = value > 0;
      }
    } else if (BOOLEAN_KEYS.has(key)) {
      valid = typeof value === "boolean";
    } else if (STRING_KEYS.has(key)) {
      valid = typeof value === "string";
    } else if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      valid =
        types.length > 0 &&
        types.every((type) => typeof type === "string" && TYPES.has(type)) &&
        new Set(types).size === types.length;
    } else if (key === "required") {
      valid =
        Array.isArray(value) &&
        value.every((name) => typeof name === "string") &&
        new Set(value).size === value.length;
    } else if (key === "enum") {
      valid = Array.isArray(value);
    } else if (key === "allOf" || key === "anyOf" || key === "oneOf") {
      valid = Array.isArray(value) && value.length > 0;
    }
    if (!valid) {
      throw new Error(`Invalid schema keyword: ${key}`);
    }
  }
  if (node.discriminator !== undefined) {
    const decoded = Schema.decodeUnknownResult(DISCRIMINATOR_SCHEMA)(
      node.discriminator,
    );
    if (Result.isFailure(decoded))
      throw new Error("Invalid OpenAPI discriminator annotation.");
    // OpenAPI forbids this hint from changing validation. Keep native composition validation,
    // rather than selecting a branch from a mapping and accidentally accepting an invalid value.
    node = Object.fromEntries(
      Object.entries(node).filter(([key]) => key !== "discriminator"),
    );
  }
  if (node.$defs !== undefined) {
    throw new Error(
      "Embedded $defs are not supported; use components.schemas.",
    );
  }
  const properties = node.properties;
  if (
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    const inherited = Object.keys(properties).find(
      (name) => name !== "__proto__" && Object.hasOwn(Object.prototype, name),
    );
    // Effect structs consider inherited fields present; JSON Schema considers own keys only.
    if (inherited !== undefined) {
      throw new Error(
        `Prototype-named schema properties are not supported: ${inherited}`,
      );
    }
  }
  if (typeof node.pattern === "string") {
    // Native pattern revivers require RegExp's canonical source, including escaped slashes.
    return { ...node, pattern: new RegExp(node.pattern, "u").source };
  }
  return node;
};
