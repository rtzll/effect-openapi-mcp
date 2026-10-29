import { JsonSchema as NativeJsonSchema, SchemaAST } from "effect";
import { UnsupportedOperationError } from "./openapi-errors.ts";
import { componentName, type JsonSchema } from "./openapi-types.ts";
import { mapSchema, schemaNode } from "./schema-document.ts";
import type { makeParameterImporter } from "./schema.ts";

const stringInput = (
  ast: SchemaAST.AST,
  active = new Set<SchemaAST.AST>(),
): boolean => {
  if (
    active.has(ast) ||
    ast.annotations?.format === "binary" ||
    ast.annotations?.format === "byte" ||
    ast.annotations?.contentEncoding !== undefined
  )
    return false;
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return true;
    case "Literal":
      return typeof ast.literal === "string";
    case "Enum":
      return (
        ast.enums.length > 0 &&
        ast.enums.every(([, value]) => typeof value === "string")
      );
    case "Union": {
      const visited = new Set(active).add(ast);
      return (
        ast.types.length > 0 &&
        ast.types.every((child) => stringInput(child, visited))
      );
    }
    case "Suspend":
      return stringInput(ast.thunk(), new Set(active).add(ast));
    default:
      return false;
  }
};
const assertTextAnnotations = (
  schema: JsonSchema,
  components: Readonly<Record<string, JsonSchema>>,
  version: string,
): void => {
  const convert = version.startsWith("3.0.")
    ? NativeJsonSchema.fromSchemaOpenApi3_0
    : NativeJsonSchema.fromSchemaOpenApi3_1;
  const visited = new Set<string>();
  const inspect = (source: JsonSchema): void => {
    if (typeof source === "boolean") return;
    // Native dialect conversion honors 3.0 ignored reference siblings before traversing annotations.
    mapSchema(schemaNode(convert(source).schema), (node) => {
      if (
        node.format === "binary" ||
        node.format === "byte" ||
        node.contentEncoding !== undefined
      ) {
        throw new UnsupportedOperationError(
          "Text request bodies require a provably non-null, nonbinary string schema.",
        );
      }
      if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
        const name = componentName(
          node.$ref.replace("#/$defs/", "#/components/schemas/"),
          "schemas",
        );
        if (!visited.has(name)) {
          visited.add(name);
          const target = Object.hasOwn(components, name)
            ? components[name]
            : undefined;
          if (target === undefined)
            throw new UnsupportedOperationError(
              "Unresolved text request schema component.",
            );
          inspect(target);
        }
      }
      return node;
    });
  };
  inspect(schema);
};
export const assertTextInput = (
  schema: JsonSchema,
  importParameters: ReturnType<typeof makeParameterImporter>,
  components: Readonly<Record<string, JsonSchema>>,
  version: string,
): void => {
  const imported = importParameters({
    type: "object",
    properties: { body: schema },
    required: ["body"],
    additionalProperties: false,
  });
  const encoded = SchemaAST.toEncoded(imported.ast);
  assertTextAnnotations(schema, components, version);
  const body =
    encoded._tag === "Objects"
      ? encoded.propertySignatures.find((property) => property.name === "body")
      : undefined;
  if (body === undefined || !stringInput(body.type)) {
    throw new UnsupportedOperationError(
      "Text request bodies require a provably non-null, nonbinary string schema.",
    );
  }
};
