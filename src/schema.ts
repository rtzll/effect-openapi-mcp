import { JsonSchema, Schema, SchemaRepresentation } from "effect";
import { UnsupportedOperationError } from "./openapi-errors.ts";
import { normalizeLegacyPattern } from "./legacy-pattern.ts";
import { makeCompositionNormalizer } from "./schema-composition.ts";
import {
  componentName,
  type JsonObject,
  type JsonSchema as ApiSchema,
} from "./openapi-types.ts";
import {
  mapSchema,
  schemaNode,
  validateSchemaNode,
} from "./schema-document.ts";

const SCALAR_SCHEMA = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
]);
const PARAMETER_SCHEMA = Schema.Union([
  SCALAR_SCHEMA,
  Schema.Array(SCALAR_SCHEMA).pipe(Schema.mutable),
]);
export const ARGUMENTS_SCHEMA = Schema.Struct({
  path: Schema.optionalKey(Schema.Record(Schema.String, SCALAR_SCHEMA)),
  query: Schema.optionalKey(Schema.Record(Schema.String, Schema.MutableJson)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, PARAMETER_SCHEMA)),
  body: Schema.optionalKey(Schema.MutableJson),
});
export type OperationArguments = typeof ARGUMENTS_SCHEMA.Type;
export type ScalarParameterValue = typeof SCALAR_SCHEMA.Type;
const ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
]);
const normalize = (node: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  if (node.$vocabulary !== undefined) {
    throw new Error("Explicit JSON Schema vocabularies are not supported.");
  }
  const dialect = node.$schema;
  if (typeof dialect === "string") {
    if (
      ![
        "https://json-schema.org/draft/2020-12/schema",
        "https://spec.openapis.org/oas/3.1/dialect/base",
        "https://spec.openapis.org/oas/3.2/dialect/2025-09-17",
        "https://spec.openapis.org/oas/3.2/dialect/2026-02-26",
      ].includes(dialect.replace(/#$/, ""))
    ) {
      throw new Error("Unsupported JSON Schema dialect.");
    }
  }
  if (node.type === "integer") {
    return {
      ...node,
      minimum: Math.max(
        typeof node.minimum === "number"
          ? node.minimum
          : Number.MIN_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
      ),
      maximum: Math.min(
        typeof node.maximum === "number"
          ? node.maximum
          : Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ),
    };
  }
  if (!Array.isArray(node.type)) {
    return node;
  }
  // Distribute a type union over the remaining constraints to avoid overlapping intersections.
  const checked = schemaNode(node);
  if (typeof checked === "boolean") {
    throw new Error("Unexpected boolean schema node.");
  }
  const { type, ...rest } = checked;
  if (!Array.isArray(type)) {
    return node;
  }
  return {
    ...Object.fromEntries(
      Object.entries(rest).filter(([key]) => ANNOTATIONS.has(key)),
    ),
    anyOf: type.map((type) => ({ ...rest, type })),
  };
};
export const makeParameterImporter = (
  components: Readonly<Record<string, ApiSchema>>,
  version: string,
  dialect?: string,
) => {
  const legacy = version.startsWith("3.0.");
  const convert = legacy
    ? JsonSchema.fromSchemaOpenApi3_0
    : JsonSchema.fromSchemaOpenApi3_1;
  const converted = new Map<string, Exclude<ApiSchema, boolean>>();
  const prepare = (schema: ApiSchema) => {
    if (typeof schema === "boolean") {
      return schema ? {} : { not: {} };
    }
    const document = convert(schema);
    if (Object.keys(document.definitions).length > 0) {
      throw new Error(
        "Embedded $defs are not supported; use components.schemas.",
      );
    }
    const prepared = mapSchema(schemaNode(document.schema), (node) =>
      validateSchemaNode(
        legacy && typeof node.pattern === "string"
          ? { ...node, pattern: normalizeLegacyPattern(node.pattern) }
          : node,
      ),
    );
    if (typeof prepared === "boolean") {
      throw new Error("Unexpected boolean schema conversion.");
    }
    return prepared;
  };
  return (schema: JsonObject) => {
    try {
      const root = prepare(
        dialect === undefined ? schema : { ...schema, $schema: dialect },
      );
      const definitions = new Map<string, Exclude<ApiSchema, boolean>>();
      const collect = (schema: ApiSchema): void => {
        mapSchema(schema, (node) => {
          if (
            typeof node.$ref !== "string" ||
            !node.$ref.startsWith("#/$defs/")
          ) {
            return node;
          }
          const name = componentName(
            node.$ref.replace("#/$defs/", "#/components/schemas/"),
            "schemas",
          );
          if (definitions.has(name)) {
            return node;
          }
          const original = Object.hasOwn(components, name)
            ? components[name]
            : undefined;
          if (original === undefined) {
            throw new Error(`Unresolved schema component: ${name}`);
          }
          let definition = converted.get(name);
          if (definition === undefined) {
            const prepared = prepare(original);
            if (typeof prepared === "boolean") {
              throw new Error("Unexpected boolean schema conversion.");
            }
            definition = prepared;
            converted.set(name, definition);
          }
          definitions.set(name, definition);
          collect(definition);
          return node;
        });
      };
      collect(root);
      const isReadOnly = (
        schema: ApiSchema,
        visited = new Set<string>(),
      ): boolean => {
        if (typeof schema === "boolean") {
          return false;
        }
        if (schema.readOnly === true) {
          return true;
        }
        if (
          typeof schema.$ref === "string" &&
          schema.$ref.startsWith("#/$defs/")
        ) {
          const name = componentName(
            schema.$ref.replace("#/$defs/", "#/components/schemas/"),
            "schemas",
          );
          if (!visited.has(name)) {
            visited.add(name);
            const definition = definitions.get(name);
            if (
              definition !== undefined &&
              isReadOnly(schemaNode(definition), visited)
            ) {
              return true;
            }
          }
        }
        return (
          Array.isArray(schema.allOf) &&
          schema.allOf.some((child) =>
            isReadOnly(schemaNode(child), new Set(visited)),
          )
        );
      };
      // Never inline across a schema resource boundary, including descendants of $id.
      // Leave scoped documents to the native importer's reference validation.
      let hasScopedReferences = false;
      const requestNode = (node: Exclude<ApiSchema, boolean>) => {
        if (
          ["$id", "$anchor", "$dynamicAnchor", "$dynamicRef"].some((key) =>
            Object.hasOwn(node, key),
          )
        )
          hasScopedReferences = true;
        const properties = node.properties;
        if (
          !Array.isArray(node.required) ||
          properties === null ||
          typeof properties !== "object" ||
          Array.isArray(properties)
        ) {
          return node;
        }
        return {
          ...node,
          required: node.required.filter(
            (name) =>
              typeof name === "string" &&
              (!Object.hasOwn(properties, name) ||
                !isReadOnly(schemaNode(properties[name]))),
          ),
        };
      };
      const requestSchema = (schema: Exclude<ApiSchema, boolean>) =>
        mapSchema(schema, requestNode);
      const requestRoot = requestSchema(root);
      const requestDefinitions = Object.fromEntries(
        [...definitions].map(([name, definition]) => [
          name,
          requestSchema(definition),
        ]),
      );
      const normalizeComposition =
        makeCompositionNormalizer(requestDefinitions);
      const imported = SchemaRepresentation.fromJsonSchemaDocument(
        {
          dialect: "draft-2020-12",
          schema: requestRoot,
          definitions: requestDefinitions,
        },
        {
          patterns: "apply",
          onEnter: (node) => {
            const checked = schemaNode(normalize(node));
            if (typeof checked === "boolean")
              throw new Error("Unexpected boolean schema normalization.");
            // Merged object properties can reveal readOnly requirements across allOf.
            return requestNode(
              hasScopedReferences ? checked : normalizeComposition(checked),
            );
          },
        },
      );
      // Built-in JSON Schema imports need no services; the envelope validates the decoded type.
      return Schema.make<Schema.Codec<unknown>>(imported.ast).pipe(
        Schema.decodeTo(ARGUMENTS_SCHEMA),
      );
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "Cannot import the operation schema.";
      throw new UnsupportedOperationError(
        `Unsupported input schema: ${reason}`,
      );
    }
  };
};
