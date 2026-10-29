import { Result, Schema } from "effect";
import {
  DEFAULT_PARAMETER_PROFILE,
  isBracketSegment,
  wireNamespace,
  type ParameterProfile,
} from "./parameter-profile.ts";
import { parameterShapes } from "./parameter-shape.ts";
import { InvalidArguments } from "./api-errors.ts";
import {
  encodeStyled,
  formEncode,
  MAX_BRACKET_BYTES,
  MAX_BRACKET_PAIRS,
  type QueryEncoding,
} from "./parameter-encoding.ts";
import { UnsupportedOperationError } from "./openapi-errors.ts";
import {
  componentName,
  JSON_SCHEMA,
  type JsonSchema,
  type JsonValue,
  type MediaType,
} from "./openapi-types.ts";

const invalid = (message: string): never => {
  throw new InvalidArguments({ message });
};
const scalar = (value: JsonValue): string =>
  value !== null && typeof value !== "object"
    ? String(value)
    : invalid("HTTP style values must be non-null scalars.");

export type FormField =
  | Readonly<{ mode: "auto" }>
  | Readonly<{ mode: "json" }>
  | Readonly<{ mode: "text" }>
  | Readonly<{ mode: "style"; encoding: QueryEncoding }>;
export type FormBody = Readonly<{
  fields: Readonly<Record<string, FormField>>;
}>;

const REFERENCE_ANNOTATIONS = new Set([
  "$comment",
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "externalDocs",
  "xml",
  "discriminator",
]);

export const resolveFormObjectSchema = (
  schema: JsonSchema,
  components: Readonly<Record<string, JsonSchema>>,
  version: string,
  visited = new Set<string>(),
): Exclude<JsonSchema, boolean> => {
  if (typeof schema === "boolean") {
    throw new UnsupportedOperationError(
      "Form bodies require an object schema.",
    );
  }
  if (typeof schema.$ref !== "string") {
    return schema;
  }
  if (!version.startsWith("3.0.")) {
    const siblings = Object.keys(schema).filter(
      (key) =>
        key !== "$ref" &&
        !REFERENCE_ANNOTATIONS.has(key) &&
        !key.startsWith("x-"),
    );
    if (siblings.length > 0) {
      throw new UnsupportedOperationError(
        `Form schema $ref siblings are not supported (${siblings.join(", ")}); inline the effective schema for form serialization.`,
      );
    }
  }
  if (visited.has(schema.$ref)) {
    throw new UnsupportedOperationError("Recursive form body schema.");
  }
  visited.add(schema.$ref);
  const name = componentName(schema.$ref, "schemas");
  const target = Object.hasOwn(components, name) ? components[name] : undefined;
  if (target === undefined) {
    throw new UnsupportedOperationError(`Unresolved form schema: ${name}`);
  }
  // OpenAPI 3.0 ignores reference siblings; later dialects retain annotations only here.
  // Validation still uses the original schema through the native importer.
  return resolveFormObjectSchema(target, components, version, visited);
};
const decodeSchema = (value: unknown): JsonSchema => {
  const result = Schema.decodeUnknownResult(JSON_SCHEMA)(value);
  if (Result.isFailure(result)) {
    throw new UnsupportedOperationError("Invalid form field schema.");
  }
  return result.success;
};
export const compileFormBody = (
  media: MediaType,
  components: Readonly<Record<string, JsonSchema>>,
  version: string,
  profile: ParameterProfile = DEFAULT_PARAMETER_PROFILE,
): FormBody => {
  const root = resolveFormObjectSchema(
    media.schema ?? true,
    components,
    version,
  );
  if (root.type !== "object") {
    throw new UnsupportedOperationError(
      "Form bodies require an explicit object schema.",
    );
  }
  if (media.prefixEncoding !== undefined || media.itemEncoding !== undefined) {
    throw new UnsupportedOperationError(
      "Positional form encoding is not supported.",
    );
  }
  const fields = new Map<string, FormField>();
  const properties = root.properties;
  if (
    root.allOf !== undefined ||
    root.anyOf !== undefined ||
    root.oneOf !== undefined
  ) {
    throw new UnsupportedOperationError(
      "Composed form body schemas are not supported.",
    );
  }
  if (
    properties !== undefined &&
    (properties === null ||
      typeof properties !== "object" ||
      Array.isArray(properties))
  ) {
    throw new UnsupportedOperationError("Invalid form property schemas.");
  }
  const propertySchemas = properties === undefined ? {} : properties;
  for (const name of Object.keys(media.encoding ?? {})) {
    if (!Object.hasOwn(propertySchemas, name)) {
      throw new UnsupportedOperationError(
        `Encoding refers to an undeclared form property: ${name}`,
      );
    }
  }
  const assertDefault = (value: JsonSchema, nestedArray = false): void => {
    const field = resolveFormObjectSchema(value, components, version);
    if (
      field.format === "binary" ||
      field.format === "byte" ||
      field.contentEncoding !== undefined
    ) {
      throw new UnsupportedOperationError(
        "Binary form fields require an explicit supported text encoding.",
      );
    }
    if (field.type === "array") {
      if (nestedArray)
        throw new UnsupportedOperationError(
          "Nested form arrays require explicit JSON content encoding.",
        );
      assertDefault(decodeSchema(field.items), true);
    } else if (
      !["string", "number", "integer", "boolean", "object"].includes(
        typeof field.type === "string" ? field.type : "",
      )
    ) {
      throw new UnsupportedOperationError(
        "Untyped/union form fields require explicit content encoding.",
      );
    }
  };
  for (const [name, value] of Object.entries(propertySchemas)) {
    const encoding = Object.hasOwn(media.encoding ?? {}, name)
      ? (media.encoding?.[name] ?? {})
      : {};
    if (
      encoding.encoding !== undefined ||
      encoding.prefixEncoding !== undefined ||
      encoding.itemEncoding !== undefined
    ) {
      throw new UnsupportedOperationError(
        "Nested form encoding is not supported.",
      );
    }
    if (encoding.allowReserved === true) {
      throw new UnsupportedOperationError(
        "allowReserved form encoding is not supported.",
      );
    }
    const styled =
      encoding.style !== undefined ||
      encoding.explode !== undefined ||
      encoding.allowReserved !== undefined;
    if (!styled) {
      if (encoding.contentType === undefined) {
        assertDefault(decodeSchema(value));
        fields.set(name, { mode: "auto" });
      } else if (encoding.contentType === "text/plain") {
        const shapes = parameterShapes(
          decodeSchema(value),
          components,
          version,
        );
        if (
          [...shapes].some((shape) => shape !== "scalar" && shape !== "array")
        ) {
          throw new UnsupportedOperationError(
            "Explicit text/plain form fields require non-null scalars or scalar arrays.",
          );
        }
        fields.set(name, { mode: "text" });
      } else if (
        encoding.contentType === "application/json" ||
        /^application\/[A-Za-z0-9!#$&^_.+-]+\+json$/.test(encoding.contentType)
      ) {
        fields.set(name, { mode: "json" });
      } else {
        throw new UnsupportedOperationError(
          `Unsupported form field content type: ${encoding.contentType}`,
        );
      }
      continue;
    }
    const style = encoding.style ?? "form";
    if (
      style !== "form" &&
      style !== "deepObject" &&
      style !== "spaceDelimited" &&
      style !== "pipeDelimited"
    ) {
      throw new UnsupportedOperationError(
        `Unsupported form encoding style: ${style}`,
      );
    }
    const explode = encoding.explode ?? style === "form";
    if (style === "deepObject" && profile === "brackets-indexed") {
      if (!isBracketSegment(name)) {
        throw new UnsupportedOperationError(
          "Bracket form field names must be safe nonnumeric object keys.",
        );
      }
      fields.set(name, {
        mode: "style",
        encoding: { style, explode, profile },
      });
      continue;
    }
    const shapes = parameterShapes(decodeSchema(value), components, version);
    if (
      style === "deepObject" &&
      (!shapes.has("object") ||
        shapes.size !== 1 ||
        (!version.startsWith("3.2.") && !explode))
    ) {
      throw new UnsupportedOperationError(
        "deepObject form encoding requires an object and explode: true in OpenAPI 3.0/3.1; nested values and arrays are undefined.",
      );
    }
    if (
      (style === "spaceDelimited" || style === "pipeDelimited") &&
      (!shapes.has("array") || shapes.size !== 1 || explode)
    ) {
      throw new UnsupportedOperationError(
        "Delimited form encoding requires an array and explode: false.",
      );
    }
    fields.set(name, { mode: "style", encoding: { style, explode } });
  }
  return { fields: Object.fromEntries(fields) };
};

export const encodeFormBody = (
  body: JsonValue,
  descriptor: FormBody,
): string => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalid("A form request body must be an object.");
  }
  const fields: Array<readonly [string, string]> = [];
  const owners = new Map<string, string>();
  const namespaces = new Map<string, Set<string>>();
  const profileNamespaces = new Set<string>();
  const usesProfile = Object.values(descriptor.fields).some(
    (field) =>
      field.mode === "style" && field.encoding.profile === "brackets-indexed",
  );
  let encodedBytes = 0;
  const append = (...pairs: ReadonlyArray<readonly [string, string]>): void => {
    for (const pair of pairs) {
      if (usesProfile) {
        if (fields.length >= MAX_BRACKET_PAIRS)
          invalid("The form exceeds the bracket profile's wire pair limit.");
        encodedBytes +=
          formEncode(pair[0]).length +
          1 +
          pair[1].length +
          (fields.length === 0 ? 0 : 1);
        if (encodedBytes > MAX_BRACKET_BYTES)
          invalid("The form exceeds the bracket profile's encoded byte limit.");
      }
      fields.push(pair);
    }
  };
  const auto = (name: string, value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        // Array items that are themselves complex values use their JSON representation.
        append([
          name,
          formEncode(
            item !== null && typeof item === "object"
              ? JSON.stringify(item)
              : scalar(item),
          ),
        ]);
      }
    } else {
      append([
        name,
        formEncode(
          value !== null && typeof value === "object"
            ? JSON.stringify(value)
            : scalar(value),
        ),
      ]);
    }
  };
  for (const [name, value] of Object.entries(body)) {
    const offset = fields.length;
    const field = Object.hasOwn(descriptor.fields, name)
      ? descriptor.fields[name]
      : undefined;
    if (field === undefined) {
      return invalid(`No encoding is declared for form field: ${name}`);
    }
    if (field.mode === "auto") {
      auto(name, value);
    } else if (field.mode === "text") {
      for (const item of Array.isArray(value) ? value : [value]) {
        append([name, formEncode(scalar(item))]);
      }
    } else if (field.mode === "json") {
      for (const item of Array.isArray(value) ? value : [value]) {
        append([name, formEncode(JSON.stringify(item))]);
      }
    } else {
      append(...encodeStyled(name, value, field.encoding, formEncode));
    }
    for (const [key] of fields.slice(offset)) {
      const namespace = wireNamespace(key);
      const previousOwners = namespaces.get(namespace) ?? new Set<string>();
      const profiled =
        field.mode === "style" && field.encoding.profile === "brackets-indexed";
      if (
        (profiled || profileNamespaces.has(namespace)) &&
        [...previousOwners].some((owner) => owner !== name)
      ) {
        return invalid(
          "Expanded form fields have conflicting bracket namespaces.",
        );
      }
      if (profiled) profileNamespaces.add(namespace);
      previousOwners.add(name);
      namespaces.set(namespace, previousOwners);
      const previous = owners.get(key);
      if (previous !== undefined && previous !== name) {
        return invalid("Expanded form fields have conflicting wire names.");
      }
      owners.set(key, name);
    }
  }
  return fields
    .map(([name, value]) => `${formEncode(name)}=${value}`)
    .join("&");
};
