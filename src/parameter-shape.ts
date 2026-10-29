import { Result, Schema } from "effect";
import { UnsupportedOperationError } from "./openapi-errors.ts";
import {
  componentName,
  JSON_SCHEMA,
  type JsonSchema,
} from "./openapi-types.ts";

type Shape = "scalar" | "null" | "array" | "object";
const schemaValue = (value: unknown): JsonSchema => {
  const result = Schema.decodeUnknownResult(JSON_SCHEMA)(value);
  if (Result.isFailure(result)) {
    throw new UnsupportedOperationError("Invalid HTTP serialization schema.");
  }
  return result.success;
};

// Determine wire shapes, independently of validation (which remains the native Schema importer).
// A finite shape is required: nested HTTP-style values have no portable OpenAPI encoding.
export const parameterShapes = (
  schema: JsonSchema,
  components: Readonly<Record<string, JsonSchema>>,
  version: string,
  visited = new Set<string>(),
): ReadonlySet<Shape> => {
  if (typeof schema === "boolean") {
    throw new UnsupportedOperationError(
      "Unbounded HTTP-style values are not supported.",
    );
  }
  if (typeof schema.$ref === "string") {
    if (visited.has(schema.$ref)) {
      throw new UnsupportedOperationError(
        "Recursive HTTP-style values are not supported.",
      );
    }
    const name = componentName(schema.$ref, "schemas");
    const target = Object.hasOwn(components, name)
      ? components[name]
      : undefined;
    if (target === undefined) {
      throw new UnsupportedOperationError(
        `Unresolved HTTP serialization schema: ${name}`,
      );
    }
    const next = new Set(visited).add(schema.$ref);
    const shapes = parameterShapes(target, components, version, next);
    if (version.startsWith("3.0.")) {
      return shapes;
    }
    const siblings = Object.fromEntries(
      Object.entries(schema).filter(([key]) => key !== "$ref"),
    );
    if (
      siblings.type !== undefined ||
      siblings.anyOf !== undefined ||
      siblings.oneOf !== undefined ||
      siblings.allOf !== undefined
    ) {
      const other = parameterShapes(siblings, components, version, next);
      return new Set([...shapes].filter((shape) => other.has(shape)));
    }
    return shapes;
  }
  const inspect = (value: unknown) =>
    parameterShapes(schemaValue(value), components, version, new Set(visited));
  const shapes = new Set<Shape>();
  if (schema.type !== undefined) {
    for (const type of Array.isArray(schema.type)
      ? schema.type
      : [schema.type]) {
      if (type === "null") {
        shapes.add("null");
      } else if (
        type === "string" ||
        type === "number" ||
        type === "integer" ||
        type === "boolean"
      ) {
        shapes.add("scalar");
      } else if (type === "array") {
        const items = inspect(schema.items);
        if (items.has("null")) {
          throw new UnsupportedOperationError(
            "Nullable array parameter items are not supported.",
          );
        }
        if ([...items].some((shape) => shape !== "scalar")) {
          throw new UnsupportedOperationError(
            "Only scalar array parameters are supported.",
          );
        }
        shapes.add("array");
      } else if (type === "object") {
        const properties = schema.properties;
        if (
          properties !== undefined &&
          (properties === null ||
            typeof properties !== "object" ||
            Array.isArray(properties))
        ) {
          throw new UnsupportedOperationError(
            "Invalid HTTP-style object properties.",
          );
        }
        const members =
          properties === undefined ? [] : Object.values(properties);
        if (schema.additionalProperties !== false) {
          if (
            schema.additionalProperties === undefined ||
            schema.additionalProperties === true
          ) {
            throw new UnsupportedOperationError(
              "HTTP-style objects require bounded scalar properties.",
            );
          }
          members.push(schema.additionalProperties);
        }
        if (
          members.some((member) =>
            [...inspect(member)].some((shape) => shape !== "scalar"),
          )
        ) {
          throw new UnsupportedOperationError(
            "HTTP-style objects require non-null scalar properties; nested values are undefined.",
          );
        }
        if (schema.patternProperties !== undefined) {
          throw new UnsupportedOperationError(
            "Patterned HTTP-style objects are not supported.",
          );
        }
        shapes.add("object");
      } else {
        throw new UnsupportedOperationError(
          "Unsupported HTTP serialization type.",
        );
      }
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    const alternatives = variants
      .filter(
        (variant) =>
          key !== "allOf" ||
          (typeof variant === "object" &&
            variant !== null &&
            !Array.isArray(variant) &&
            ["type", "$ref", "anyOf", "oneOf", "allOf"].some((keyword) =>
              Object.hasOwn(variant, keyword),
            )),
      )
      .map(inspect);
    if (alternatives.length === 0) {
      continue;
    }
    const combined = new Set<Shape>(
      alternatives.flatMap((variant) => [...variant]),
    );
    if (shapes.size === 0) {
      for (const shape of combined) shapes.add(shape);
    } else {
      for (const shape of shapes)
        if (!combined.has(shape)) shapes.delete(shape);
    }
  }
  if (schema.nullable === true) {
    shapes.add("null");
  }
  if (shapes.size === 0) {
    throw new UnsupportedOperationError(
      "Unbounded HTTP-style values are not supported.",
    );
  }
  return shapes;
};
