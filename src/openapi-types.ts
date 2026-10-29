import { Effect, Schema } from "effect";
import { UnsupportedOperationError } from "./openapi-errors.ts";

export const JSON_SCHEMA = Schema.Union([
  Schema.Boolean,
  Schema.Record(Schema.String, Schema.MutableJson),
]);
export type JsonSchema = typeof JSON_SCHEMA.Type;
export type JsonValue = Schema.MutableJson;
export type JsonObject = Record<string, JsonValue>;

const REFERENCE_SCHEMA = Schema.Struct({ $ref: Schema.String });
export type Reference = typeof REFERENCE_SCHEMA.Type;

const ENCODING_SCHEMA = Schema.Struct({
  contentType: Schema.String.pipe(Schema.optionalKey),
  headers: Schema.MutableJson.pipe(Schema.optionalKey),
  style: Schema.String.pipe(Schema.optionalKey),
  explode: Schema.Boolean.pipe(Schema.optionalKey),
  allowReserved: Schema.Boolean.pipe(Schema.optionalKey),
  encoding: Schema.MutableJson.pipe(Schema.optionalKey),
  prefixEncoding: Schema.MutableJson.pipe(Schema.optionalKey),
  itemEncoding: Schema.MutableJson.pipe(Schema.optionalKey),
});
const MEDIA_SCHEMA = Schema.Struct({
  schema: JSON_SCHEMA.pipe(Schema.optionalKey),
  itemSchema: JSON_SCHEMA.pipe(Schema.optionalKey),
  encoding: Schema.Record(Schema.String, ENCODING_SCHEMA).pipe(
    Schema.optionalKey,
  ),
  prefixEncoding: Schema.MutableJson.pipe(Schema.optionalKey),
  itemEncoding: Schema.MutableJson.pipe(Schema.optionalKey),
});
export type MediaType = typeof MEDIA_SCHEMA.Type;
const MEDIA_OR_REFERENCE = Schema.Union([REFERENCE_SCHEMA, MEDIA_SCHEMA]);
const CONTENT_SCHEMA = Schema.Record(Schema.String, MEDIA_OR_REFERENCE);
const PARAMETER_SCHEMA = Schema.Struct({
  name: Schema.NonEmptyString,
  in: Schema.Literals(["path", "query", "querystring", "header", "cookie"]),
  required: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  description: Schema.String.pipe(Schema.optionalKey),
  schema: JSON_SCHEMA.pipe(Schema.optionalKey),
  content: CONTENT_SCHEMA.pipe(Schema.optionalKey),
  style: Schema.String.pipe(Schema.optionalKey),
  explode: Schema.Boolean.pipe(Schema.optionalKey),
  allowReserved: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
});
const PARAMETER_OR_REFERENCE = Schema.Union([
  REFERENCE_SCHEMA,
  PARAMETER_SCHEMA,
]);
export type ApiParameter = typeof PARAMETER_SCHEMA.Type;

const IGNORED_HEADER_PARAMETERS = new Set([
  "accept",
  "content-type",
  "authorization",
]);

/** OpenAPI handles these headers through security and media metadata, not parameters. */
export const isIgnoredHeaderParameter = (parameter: {
  readonly in?: unknown;
  readonly name?: unknown;
}): boolean =>
  parameter.in === "header" &&
  typeof parameter.name === "string" &&
  IGNORED_HEADER_PARAMETERS.has(parameter.name.toLowerCase());

const BODY_SCHEMA = Schema.Struct({
  required: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  description: Schema.String.pipe(Schema.optionalKey),
  content: CONTENT_SCHEMA,
});
const BODY_OR_REFERENCE = Schema.Union([REFERENCE_SCHEMA, BODY_SCHEMA]);
const RESPONSE_SCHEMA = Schema.Struct({
  content: CONTENT_SCHEMA.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});
const RESPONSE_OR_REFERENCE = Schema.Union([REFERENCE_SCHEMA, RESPONSE_SCHEMA]);
const SECURITY_SCHEMA = Schema.Array(
  Schema.Record(Schema.String, Schema.Array(Schema.String)),
);
const SERVER_SCHEMA = Schema.Struct({
  url: Schema.String,
  variables: Schema.Record(
    Schema.String,
    Schema.Struct({ default: Schema.String }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});
const SERVERS_SCHEMA = Schema.Array(SERVER_SCHEMA);
const OPERATION_SCHEMA = Schema.Struct({
  $ref: Schema.String.pipe(Schema.optionalKey),
  servers: Schema.optionalKey(SERVERS_SCHEMA),
  operationId: Schema.NonEmptyString.pipe(Schema.optionalKey),
  summary: Schema.String.pipe(Schema.optionalKey),
  description: Schema.String.pipe(Schema.optionalKey),
  tags: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  parameters: Schema.Array(PARAMETER_OR_REFERENCE).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  requestBody: BODY_OR_REFERENCE.pipe(Schema.optionalKey),
  responses: Schema.Record(Schema.String, RESPONSE_OR_REFERENCE).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  security: SECURITY_SCHEMA.pipe(Schema.optionalKey),
  "x-mcp-read-only": Schema.Boolean.pipe(Schema.optionalKey),
});
export type ApiOperation = typeof OPERATION_SCHEMA.Type;

export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
  "query",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

const PATH_SCHEMA = Schema.Struct({
  servers: Schema.optionalKey(SERVERS_SCHEMA),
  $ref: Schema.String.pipe(Schema.optionalKey),
  parameters: Schema.Array(PARAMETER_OR_REFERENCE).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  get: OPERATION_SCHEMA.pipe(Schema.optionalKey),
  post: OPERATION_SCHEMA.pipe(Schema.optionalKey),
  put: OPERATION_SCHEMA.pipe(Schema.optionalKey),
  patch: OPERATION_SCHEMA.pipe(Schema.optionalKey),
  delete: OPERATION_SCHEMA.pipe(Schema.optionalKey),
  head: OPERATION_SCHEMA.pipe(Schema.optionalKey),
  options: OPERATION_SCHEMA.pipe(Schema.optionalKey),
  trace: OPERATION_SCHEMA.pipe(Schema.optionalKey),
  query: OPERATION_SCHEMA.pipe(Schema.optionalKey),
  additionalOperations: Schema.Record(Schema.String, OPERATION_SCHEMA).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});
export const OPENAPI_SCHEMA = Schema.Struct({
  openapi: Schema.String.check(Schema.isPattern(/^3\.[012]\.\d+$/)),
  $self: Schema.NonEmptyString.pipe(Schema.optionalKey),
  jsonSchemaDialect: Schema.optionalKey(Schema.String),
  info: Schema.optionalKey(
    Schema.Struct({
      title: Schema.String,
      version: Schema.String,
      description: Schema.optionalKey(Schema.String),
    }),
  ),
  servers: SERVERS_SCHEMA.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  paths: Schema.Record(Schema.String, PATH_SCHEMA),
  security: SECURITY_SCHEMA.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  components: Schema.Struct({
    mediaTypes: Schema.Record(Schema.String, MEDIA_OR_REFERENCE).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
    schemas: Schema.Record(Schema.String, JSON_SCHEMA).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
    parameters: Schema.Record(Schema.String, PARAMETER_OR_REFERENCE).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
    requestBodies: Schema.Record(Schema.String, BODY_OR_REFERENCE).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
    responses: Schema.Record(Schema.String, RESPONSE_OR_REFERENCE).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
    ),
    securitySchemes: Schema.Record(
      Schema.String,
      Schema.Union([
        REFERENCE_SCHEMA,
        Schema.Struct({
          type: Schema.String,
          scheme: Schema.optionalKey(Schema.String),
          in: Schema.String.pipe(Schema.optionalKey),
          name: Schema.String.pipe(Schema.optionalKey),
        }),
      ]),
    ).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  }).pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed({
        mediaTypes: {},
        schemas: {},
        parameters: {},
        requestBodies: {},
        responses: {},
        securitySchemes: {},
      }),
    ),
  ),
});
export type OpenApiDocument = typeof OPENAPI_SCHEMA.Type;

export const componentName = (reference: string, section: string): string => {
  const prefix = `#/components/${section}/`;
  if (!reference.startsWith(prefix)) {
    throw new UnsupportedOperationError(`Unsupported reference: ${reference}`);
  }
  try {
    return decodeURIComponent(reference.slice(prefix.length))
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
  } catch {
    throw new UnsupportedOperationError(`Malformed reference: ${reference}`);
  }
};

export const resolveComponent = <T extends object>(
  value: T | Reference,
  components: Readonly<Record<string, T | Reference>>,
  section: string,
  visited = new Set<string>(),
): T => {
  if (!("$ref" in value)) {
    return value;
  }
  const reference = value.$ref;
  const name = componentName(reference, section);
  if (visited.has(reference)) {
    throw new UnsupportedOperationError(
      `Cyclic component reference: ${reference}`,
    );
  }
  visited.add(reference);
  const target = Object.hasOwn(components, name) ? components[name] : undefined;
  if (target === undefined) {
    throw new UnsupportedOperationError(`Unresolved reference: ${reference}`);
  }
  return resolveComponent(target, components, section, visited);
};
