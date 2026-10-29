import { isRequestHeaderName } from "./request-headers.ts";
import { createHash } from "node:crypto";
import { Redacted, Result, Schema } from "effect";
import { normalizeBaseUrl, type Credentials } from "./config.ts";
import { OpenApiError, UnsupportedOperationError } from "./openapi-errors.ts";
import {
  HTTP_METHODS,
  isIgnoredHeaderParameter,
  OPENAPI_SCHEMA,
  resolveComponent,
  type ApiOperation,
  type ApiParameter,
  type HttpMethod,
  type JsonObject,
  type JsonValue,
  type MediaType,
  type OpenApiDocument,
} from "./openapi-types.ts";
import { makeParameterImporter } from "./schema.ts";
import { parameterShapes } from "./parameter-shape.ts";
import { assertTextInput } from "./text-schema.ts";
import { compileFormBody, type FormBody } from "./form.ts";
import { compileMultipartBody, type MultipartBody } from "./multipart.ts";
import type { QueryEncoding } from "./parameter-encoding.ts";
import {
  isJsonMediaType,
  isTextResponseMediaType,
  selectRequestMediaType,
  selectResponseMediaTypes,
} from "./media-type.ts";
import {
  DEFAULT_PARAMETER_PROFILE,
  isBracketSegment,
  type ParameterProfile,
} from "./parameter-profile.ts";

export type ParameterBinding =
  | Readonly<{ name: string; location: "path" | "header"; explode: boolean }>
  | Readonly<{ name: string; location: "query"; encoding: QueryEncoding }>;
export type OperationDescriptor = Readonly<{
  name: string;
  method: HttpMethod;
  path: string;
  description: string;
  parametersSchema: ReturnType<ReturnType<typeof makeParameterImporter>>;
  baseUrl: URL;
  parameters: ReadonlyArray<ParameterBinding>;
  authentication: ReadonlyArray<AuthenticationBinding>;
  body:
    | Readonly<{ mode: "json"; contentType: string }>
    | Readonly<{ mode: "form"; contentType: string; form: FormBody }>
    | Readonly<{
        mode: "multipart";
        contentType: string;
        multipart: MultipartBody;
      }>
    | Readonly<{ mode: "text"; contentType: string }>
    | undefined;
  responseContentTypes: ReadonlyArray<string>;
  responses: Readonly<Record<string, "json" | "text" | "binary" | "empty">>;
  responseTextContentTypes?: Readonly<Record<string, ReadonlyArray<string>>>;
  responseBinaryContentTypes?: Readonly<Record<string, ReadonlyArray<string>>>;
  annotations: Readonly<{
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  }>;
}>;
export type OperationDiagnostic = Readonly<{
  method: string;
  path: string;
  reason: string;
}>;
export type OperationCatalog = Readonly<{
  operations: ReadonlyArray<OperationDescriptor>;
  unsupported: ReadonlyArray<OperationDiagnostic>;
  filtered: ReadonlyArray<OperationDiagnostic>;
}>;
export type CompileOptions = Readonly<{
  baseUrl?: URL;
  sourceUrl?: URL;
  credentials?: Credentials;
  methods?: ReadonlyArray<HttpMethod>;
  tags?: ReadonlyArray<string>;
  parameterProfile?: ParameterProfile;
  toolHeaders?: ReadonlyArray<string>;
}>;
export type AuthenticationBinding = Readonly<{
  scheme: string;
  location: "header" | "query";
  name: string;
  value: Redacted.Redacted<string>;
}>;

const METHOD_READ_ONLY = {
  get: true,
  head: true,
  options: true,
  post: false,
  put: false,
  patch: false,
  delete: false,
  trace: false,
  query: true,
} satisfies Record<HttpMethod, boolean>;
const METHOD_IDEMPOTENT = {
  ...METHOD_READ_ONLY,
  put: true,
  delete: true,
} satisfies Record<HttpMethod, boolean>;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "authorization",
  "cookie",
  "connection",
  "content-length",
  "transfer-encoding",
  "content-type",
  "accept",
]);
// oxlint-disable-next-line no-control-regex -- Reject URL normalization of raw controls at the spec boundary.
const UNSAFE_PATH_CHARACTERS = /[\\\s\u0000-\u001f]/;

// Some specifications declare an optional form body that can only encode no fields.
// Recognize a deliberately small schema subset so constraints are never discarded.
const isEmptyForm = (media: MediaType): boolean => {
  const schema = media.schema;
  return (
    schema !== undefined &&
    typeof schema !== "boolean" &&
    schema.type === "object" &&
    schema.additionalProperties === false &&
    Object.keys(schema).every((key) =>
      ["type", "properties", "additionalProperties", "required"].includes(key),
    ) &&
    (schema.properties === undefined ||
      (schema.properties !== null &&
        typeof schema.properties === "object" &&
        !Array.isArray(schema.properties) &&
        Object.keys(schema.properties).length === 0)) &&
    (schema.required === undefined ||
      (Array.isArray(schema.required) && schema.required.length === 0)) &&
    Object.keys(media).every((key) => key === "schema" || key === "encoding") &&
    Object.keys(media.encoding ?? {}).length === 0
  );
};

const securitySchemeFor = (document: OpenApiDocument, name: string) => {
  const declared = Object.hasOwn(document.components.securitySchemes, name)
    ? document.components.securitySchemes[name]
    : document.openapi.startsWith("3.2.") && name.startsWith("#/")
      ? { $ref: name }
      : undefined;
  return declared === undefined
    ? undefined
    : resolveComponent(
        declared,
        document.components.securitySchemes,
        "securitySchemes",
      );
};

const authenticationFor = (
  document: OpenApiDocument,
  operation: ApiOperation,
  credentials: Credentials,
): ReadonlyArray<AuthenticationBinding> => {
  const requirements = operation.security ?? document.security;
  if (requirements.length === 0) {
    return [];
  }
  const reasons: string[] = [];
  for (const requirement of requirements) {
    try {
      const bindings = Object.keys(requirement).map(
        (name): AuthenticationBinding => {
          const scheme = securitySchemeFor(document, name);
          if (scheme === undefined) {
            throw new UnsupportedOperationError(
              document.openapi.startsWith("3.2.")
                ? `Missing security scheme or unsupported external security reference: ${name}`
                : `Missing security scheme: ${name}`,
            );
          }
          const credential = Object.hasOwn(credentials, name)
            ? credentials[name]
            : undefined;
          if (credential === undefined) {
            throw new UnsupportedOperationError(
              `Missing credential for security scheme: ${name}`,
            );
          }
          if (
            scheme.type === "oauth2" ||
            scheme.type === "openIdConnect" ||
            (scheme.type === "http" &&
              scheme.scheme?.toLowerCase() === "bearer")
          ) {
            return {
              scheme: name,
              location: "header",
              name: "Authorization",
              value: Redacted.make(`Bearer ${Redacted.value(credential)}`),
            };
          }
          if (
            scheme.type === "http" &&
            scheme.scheme?.toLowerCase() === "basic"
          ) {
            if (!Redacted.value(credential).includes(":")) {
              throw new UnsupportedOperationError(
                `Basic credentials must be username:password for scheme: ${name}`,
              );
            }
            return {
              scheme: name,
              location: "header",
              name: "Authorization",
              value: Redacted.make(
                `Basic ${Buffer.from(Redacted.value(credential), "utf8").toString("base64")}`,
              ),
            };
          }
          if (scheme.type !== "apiKey") {
            throw new UnsupportedOperationError(
              `Unsupported authentication scheme: ${name}`,
            );
          }
          if (scheme.in !== "header" && scheme.in !== "query") {
            throw new UnsupportedOperationError(
              `Unsupported API-key location: ${scheme.in}`,
            );
          }
          if (scheme.name === undefined || scheme.name === "") {
            throw new UnsupportedOperationError(
              `Invalid API-key name: ${name}`,
            );
          }
          if (scheme.in === "header") {
            if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(scheme.name)) {
              throw new UnsupportedOperationError(
                `Invalid API-key header: ${name}`,
              );
            }
            if (
              FORBIDDEN_HEADERS.has(scheme.name.toLowerCase()) &&
              scheme.name.toLowerCase() !== "authorization"
            ) {
              throw new UnsupportedOperationError(
                `API key uses a reserved transport header: ${name}`,
              );
            }
          }
          return {
            scheme: name,
            location: scheme.in,
            name: scheme.name,
            value: credential,
          };
        },
      );
      const names = bindings.map(
        (binding) =>
          `${binding.location}:${binding.location === "header" ? binding.name.toLowerCase() : binding.name}`,
      );
      for (const binding of bindings) {
        if (binding.location === "header") {
          try {
            const value = Redacted.value(binding.value);
            const headers = new Headers({ [binding.name]: value });
            if (headers.get(binding.name) !== value) {
              throw new Error(
                "Header normalization would change the credential.",
              );
            }
          } catch {
            throw new UnsupportedOperationError(
              `Credential cannot be transmitted unchanged in a header: ${binding.scheme}`,
            );
          }
        }
      }
      if (new Set(names).size !== names.length) {
        throw new UnsupportedOperationError(
          "Conflicting authentication bindings.",
        );
      }
      return bindings;
    } catch (error) {
      if (!(error instanceof UnsupportedOperationError)) {
        throw error;
      }
      reasons.push(error.message);
    }
  }
  throw new UnsupportedOperationError(reasons.join("; "));
};

const serverFor = (
  document: OpenApiDocument,
  operation: ApiOperation,
  inherited: OpenApiDocument["paths"][string],
  options: CompileOptions,
): URL => {
  try {
    if (options.baseUrl !== undefined) {
      return normalizeBaseUrl(options.baseUrl);
    }
    const server = (operation.servers ??
      inherited.servers ??
      document.servers)[0];
    if (server === undefined) {
      if (options.sourceUrl !== undefined) {
        return normalizeBaseUrl(new URL("/", options.sourceUrl));
      }
      throw new Error(
        "Missing API server; set MCP_API_BASE_URL or declare servers in the spec.",
      );
    }
    const url = server.url.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
      const variable = Object.hasOwn(server.variables, name)
        ? server.variables[name]
        : undefined;
      if (variable === undefined) {
        throw new Error(`Missing server variable: ${name}`);
      }
      return variable.default;
    });
    return normalizeBaseUrl(new URL(url, options.sourceUrl));
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Invalid API server.";
    throw new UnsupportedOperationError(`Invalid API server: ${reason}`);
  }
};

const parameterSchema = (parameter: ApiParameter) => {
  if (parameter.schema === undefined) {
    throw new UnsupportedOperationError(
      `Parameter ${parameter.name} has no schema.`,
    );
  }
  const schema = parameter.schema;
  return parameter.description === undefined
    ? schema
    : {
        allOf: [schema],
        description: parameter.description,
      };
};

const serializationFor = (
  parameter: ApiParameter,
  document: OpenApiDocument,
  profile: ParameterProfile,
  importParameters: ReturnType<typeof makeParameterImporter>,
): ParameterBinding => {
  if (parameter.schema === undefined) {
    throw new UnsupportedOperationError(
      `Parameter ${parameter.name} has no schema.`,
    );
  }
  if (
    parameter.in === "query" &&
    parameter.style === "deepObject" &&
    profile === "brackets-indexed"
  ) {
    if (!isBracketSegment(parameter.name)) {
      throw new UnsupportedOperationError(
        "Bracket parameter names must be safe nonnumeric object keys.",
      );
    }
    if (parameter.required) {
      const probe = importParameters({
        type: "object",
        properties: {
          query: {
            type: "object",
            properties: { [parameter.name]: parameterSchema(parameter) },
            required: [parameter.name],
            additionalProperties: false,
          },
        },
        required: ["query"],
        additionalProperties: false,
      });
      if (
        Result.isSuccess(
          Schema.decodeResult(probe)({
            query: { [parameter.name]: null },
          }),
        )
      ) {
        throw new UnsupportedOperationError(
          "Required nullable query parameters cannot be omitted.",
        );
      }
    }
    return {
      name: parameter.name,
      location: "query",
      encoding: {
        style: "deepObject",
        explode: parameter.explode ?? false,
        profile,
      },
    };
  }
  const shapes = parameterShapes(
    parameter.schema,
    document.components.schemas,
    document.openapi,
  );
  if (parameter.in === "path" || parameter.in === "header") {
    if (shapes.has("null")) {
      throw new UnsupportedOperationError(
        "Nullable path/header parameters are not supported.",
      );
    }
    if (shapes.has("object")) {
      throw new UnsupportedOperationError(
        "Object path/header parameters are not supported.",
      );
    }
    if (parameter.in === "path" && shapes.has("array")) {
      throw new UnsupportedOperationError(
        "Array path parameters are not supported.",
      );
    }
    if ((parameter.style ?? "simple") !== "simple") {
      throw new UnsupportedOperationError(
        `Unsupported parameter style: ${parameter.style}`,
      );
    }
    return {
      name: parameter.name,
      location: parameter.in,
      explode: parameter.explode ?? false,
    };
  }
  if (parameter.in !== "query") {
    throw new UnsupportedOperationError(
      `Unsupported parameter location: ${parameter.in}`,
    );
  }
  if (parameter.required && shapes.has("null")) {
    throw new UnsupportedOperationError(
      "Required nullable query parameters cannot be omitted.",
    );
  }
  const style = parameter.style ?? "form";
  if (
    style !== "form" &&
    style !== "deepObject" &&
    style !== "spaceDelimited" &&
    style !== "pipeDelimited"
  ) {
    throw new UnsupportedOperationError(
      `Unsupported parameter style: ${style}`,
    );
  }
  const explode = parameter.explode ?? style === "form";
  if (
    style === "deepObject" &&
    (shapes.size !== 1 ||
      !shapes.has("object") ||
      (!document.openapi.startsWith("3.2.") && !explode))
  ) {
    throw new UnsupportedOperationError(
      "deepObject query encoding requires a flat object and explode: true in OpenAPI 3.0/3.1; arrays and nested values are undefined.",
    );
  }
  if (
    (style === "spaceDelimited" || style === "pipeDelimited") &&
    (shapes.size !== 1 || !shapes.has("array") || explode)
  ) {
    throw new UnsupportedOperationError(
      "Delimited query encoding requires a scalar array and explode: false.",
    );
  }
  return {
    name: parameter.name,
    location: "query",
    encoding: { style, explode },
  };
};

const compileOperation = (
  document: OpenApiDocument,
  method: HttpMethod,
  path: string,
  operation: ApiOperation,
  inherited: OpenApiDocument["paths"][string],
  options: CompileOptions,
  importParameters: ReturnType<typeof makeParameterImporter>,
): OperationDescriptor => {
  if (operation.$ref !== undefined) {
    throw new UnsupportedOperationError(
      "Referenced operations are not supported; supply a bundled OpenAPI document.",
    );
  }
  if (method === "query" && !document.openapi.startsWith("3.2.")) {
    throw new UnsupportedOperationError("QUERY requires OpenAPI 3.2.");
  }
  if (
    !document.openapi.startsWith("3.2.") &&
    Object.keys(operation.responses).length === 0
  ) {
    throw new UnsupportedOperationError(
      "OpenAPI 3.0/3.1 operations must declare responses.",
    );
  }
  if (method === "trace") {
    throw new UnsupportedOperationError(
      "TRACE is not supported by the HTTP client.",
    );
  }
  if (
    !/^\/(?!\/)/.test(path) ||
    path.includes("?") ||
    path.includes("#") ||
    UNSAFE_PATH_CHARACTERS.test(path)
  ) {
    throw new UnsupportedOperationError("Invalid API path.");
  }
  if (path.split("/").some((part) => /^(?:\.|%2e){1,2}$/i.test(part))) {
    throw new UnsupportedOperationError(
      "API paths must not contain dot segments.",
    );
  }
  if (/[{}]/.test(path.replace(/\{[^{}]+\}/g, ""))) {
    throw new UnsupportedOperationError("Unbalanced path placeholders.");
  }
  const authentication = authenticationFor(
    document,
    operation,
    options.credentials ?? {},
  );
  const baseUrl = serverFor(document, operation, inherited, options);
  const merged = new Map<string, ApiParameter>();
  for (const values of [inherited.parameters, operation.parameters]) {
    const declared = new Set<string>();
    for (const value of values) {
      const parameter = resolveComponent(
        value,
        document.components.parameters,
        "parameters",
      );
      if (isIgnoredHeaderParameter(parameter)) {
        continue;
      }
      const key = `${parameter.in}:${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`;
      if (declared.has(key)) {
        throw new UnsupportedOperationError(
          `Duplicate parameter declaration: ${parameter.name}`,
        );
      }
      declared.add(key);
      merged.set(key, parameter);
    }
  }
  const bindings: ParameterBinding[] = [];
  for (const name of options.toolHeaders ?? []) {
    if (
      !isRequestHeaderName(name) ||
      authentication.some(
        (binding) =>
          binding.location === "header" &&
          binding.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new UnsupportedOperationError(
        "Configured tool header conflicts with authentication or transport headers.",
      );
    const key = `header:${name.toLowerCase()}`;
    if (!merged.has(key))
      merged.set(key, {
        name,
        in: "header",
        required: false,
        allowReserved: false,
        schema: { type: "string", minLength: 1 },
      });
  }
  const groups = {
    path: new Map<string, JsonValue>(),
    query: new Map<string, JsonValue>(),
    headers: new Map<string, JsonValue>(),
  };
  const required: Record<keyof typeof groups, string[]> = {
    path: [],
    query: [],
    headers: [],
  };
  for (const parameter of merged.values()) {
    if (parameter.in === "querystring") {
      throw new UnsupportedOperationError(
        "Whole-query-string parameters (in: querystring) are not supported.",
      );
    }
    if (parameter.content !== undefined) {
      throw new UnsupportedOperationError(
        `Content-based parameter serialization is not supported: ${parameter.name}`,
      );
    }
    if (parameter.in === "cookie") {
      throw new UnsupportedOperationError(
        "Cookie parameters are not supported.",
      );
    }
    const credentialParameter = (operation.security ?? document.security).some(
      (requirement) =>
        Object.keys(requirement).some((name) => {
          let scheme: ReturnType<typeof securitySchemeFor>;
          try {
            scheme = securitySchemeFor(document, name);
          } catch (error) {
            if (!(error instanceof UnsupportedOperationError)) {
              throw error;
            }
            // An unsupported alternative must not invalidate the selected authentication.
            // Keep scanning the remaining schemes to exclude every identifiable credential.
            return false;
          }
          if (scheme === undefined) {
            return false;
          }
          if (
            scheme.type === "http" ||
            scheme.type === "oauth2" ||
            scheme.type === "openIdConnect"
          ) {
            return (
              parameter.in === "header" &&
              parameter.name.toLowerCase() === "authorization"
            );
          }
          if (scheme.type !== "apiKey" || scheme.in !== parameter.in) {
            return false;
          }
          if (scheme.name === undefined) {
            return false;
          }
          if (scheme.in === "header") {
            return scheme.name.toLowerCase() === parameter.name.toLowerCase();
          }
          return scheme.name === parameter.name;
        }),
    );
    if (credentialParameter) {
      continue;
    }
    if (parameter.in === "header") {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(parameter.name)) {
        throw new UnsupportedOperationError(
          `Invalid header parameter: ${parameter.name}`,
        );
      }
      if (FORBIDDEN_HEADERS.has(parameter.name.toLowerCase())) {
        throw new UnsupportedOperationError(
          `Reserved header parameter: ${parameter.name}`,
        );
      }
    }
    if (parameter.allowReserved) {
      throw new UnsupportedOperationError(
        "allowReserved parameters are not supported.",
      );
    }
    if (parameter.in === "path" && !path.includes(`{${parameter.name}}`)) {
      throw new UnsupportedOperationError(
        `Path parameter absent from path: ${parameter.name}`,
      );
    }
    const binding = serializationFor(
      parameter,
      document,
      options.parameterProfile ?? DEFAULT_PARAMETER_PROFILE,
      importParameters,
    );
    const group = parameter.in === "header" ? "headers" : parameter.in;
    groups[group].set(parameter.name, parameterSchema(parameter));
    if (parameter.required || parameter.in === "path") {
      required[group].push(parameter.name);
    }
    bindings.push(binding);
  }
  for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
    if (!groups.path.has(match[1] ?? "")) {
      throw new UnsupportedOperationError(
        `Missing path parameter: ${match[1]}`,
      );
    }
  }
  const properties = new Map<string, JsonValue>();
  const requiredGroups: string[] = [];
  for (const group of ["path", "query", "headers"] as const) {
    if (groups[group].size === 0) {
      continue;
    }
    properties.set(group, {
      type: "object",
      properties: Object.fromEntries(groups[group]),
      required: required[group],
      additionalProperties: false,
    });
    if (required[group].length > 0) {
      requiredGroups.push(group);
    }
  }
  let bodyDescriptor: OperationDescriptor["body"];
  if (operation.requestBody !== undefined) {
    const body = resolveComponent(
      operation.requestBody,
      document.components.requestBodies,
      "requestBodies",
    );
    const selectedType = selectRequestMediaType(Object.keys(body.content));
    const entry = Object.entries(body.content).find(
      ([type]) => type === selectedType,
    );
    if (entry === undefined) {
      throw new UnsupportedOperationError(
        `Unsupported request media type: ${Object.keys(body.content).join(", ")}`,
      );
    }
    const [contentType, representation] = entry;
    const media = resolveComponent(
      representation,
      document.components.mediaTypes,
      "mediaTypes",
    );
    const omitEmptyForm =
      METHOD_READ_ONLY[method] &&
      method !== "query" &&
      !body.required &&
      Object.keys(body.content).length === 1 &&
      contentType === "application/x-www-form-urlencoded" &&
      isEmptyForm(media);
    if (METHOD_READ_ONLY[method] && method !== "query" && !omitEmptyForm) {
      throw new UnsupportedOperationError(
        "Read HTTP methods with request bodies are not supported.",
      );
    }
    if (!omitEmptyForm) {
      if (media.itemSchema !== undefined) {
        throw new UnsupportedOperationError(
          "Sequential request media with itemSchema is not supported.",
        );
      }
      const text =
        !isJsonMediaType(contentType) &&
        contentType !== "application/x-www-form-urlencoded" &&
        contentType !== "multipart/form-data";
      const multipart =
        contentType === "multipart/form-data"
          ? compileMultipartBody(
              media,
              document.components.schemas,
              document.openapi,
              options.parameterProfile ?? DEFAULT_PARAMETER_PROFILE,
            )
          : undefined;
      const schema =
        multipart?.schema ?? media.schema ?? (text ? { type: "string" } : true);
      if (text)
        assertTextInput(
          schema,
          importParameters,
          document.components.schemas,
          document.openapi,
        );
      bodyDescriptor =
        multipart !== undefined
          ? { mode: "multipart", contentType, multipart: multipart.descriptor }
          : isJsonMediaType(contentType)
            ? { mode: "json", contentType }
            : text
              ? { mode: "text", contentType }
              : {
                  mode: "form",
                  contentType,
                  form: compileFormBody(
                    media,
                    document.components.schemas,
                    document.openapi,
                    options.parameterProfile ?? DEFAULT_PARAMETER_PROFILE,
                  ),
                };
      properties.set(
        "body",
        body.description === undefined
          ? schema
          : {
              allOf: [schema],
              description: body.description,
            },
      );
      if (body.required) {
        requiredGroups.push("body");
      }
    }
  }
  const responseContentTypes = new Set<string>();
  const responses = new Map<string, "json" | "text" | "binary" | "empty">();
  const responseTextContentTypes = new Map<string, ReadonlyArray<string>>();
  const responseBinaryContentTypes = new Map<string, ReadonlyArray<string>>();
  for (const [status, response] of Object.entries(operation.responses)) {
    if (!/^2\d\d$/.test(status) && status !== "2XX" && status !== "default") {
      continue;
    }
    const resolved = resolveComponent(
      response,
      document.components.responses,
      "responses",
    );
    const media = Object.keys(resolved.content);
    if (
      method === "head" ||
      status === "204" ||
      status === "205" ||
      media.length === 0
    ) {
      responses.set(status, "empty");
      continue;
    }
    const selected = selectResponseMediaTypes(media);
    for (const [type, value] of Object.entries(resolved.content)) {
      if (!selected.includes(type)) continue;
      const representation = resolveComponent(
        value,
        document.components.mediaTypes,
        "mediaTypes",
      );
      if (representation.itemSchema !== undefined) {
        throw new UnsupportedOperationError(
          "Sequential response media with itemSchema is not supported.",
        );
      }
    }
    if (selected.length > 0) {
      const mode = selected.some(isJsonMediaType)
        ? "json"
        : selected.some(isTextResponseMediaType)
          ? "text"
          : "binary";
      responses.set(status, mode);
      if (mode === "text") responseTextContentTypes.set(status, selected);
      if (mode === "binary") responseBinaryContentTypes.set(status, selected);
    }
    if (selected.length === 0 && status !== "default") {
      throw new UnsupportedOperationError(
        `Unsupported response media type: ${media.join(", ")}`,
      );
    }
    for (const type of selected) {
      responseContentTypes.add(type);
    }
  }
  const rawName =
    operation.operationId ??
    `${method}_${path
      .replace(/\{([^{}]+)\}/g, "by_$1")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")}`;
  const name = /^[A-Za-z0-9_-]{1,128}$/.test(rawName)
    ? rawName
    : `${rawName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 110)}_${createHash("sha256").update(rawName).digest("hex").slice(0, 16)}`;
  const inputSchema: JsonObject = {
    type: "object",
    properties: Object.fromEntries(properties),
    required: requiredGroups,
    additionalProperties: false,
  };
  const parametersSchema = importParameters(inputSchema);
  const readOnly = operation["x-mcp-read-only"] ?? METHOD_READ_ONLY[method];
  return {
    name,
    method,
    path,
    parametersSchema,
    baseUrl,
    parameters: bindings,
    authentication,
    body: bodyDescriptor,
    responseContentTypes: [...responseContentTypes],
    responses: Object.fromEntries(responses),
    ...(responseBinaryContentTypes.size === 0
      ? {}
      : {
          responseBinaryContentTypes: Object.fromEntries(
            responseBinaryContentTypes,
          ),
        }),
    ...(responseTextContentTypes.size === 0
      ? {}
      : {
          responseTextContentTypes: Object.fromEntries(
            responseTextContentTypes,
          ),
        }),
    description: [
      operation.summary,
      operation.description,
      `${method.toUpperCase()} ${path}. Results retain the API response shape.`,
      ...(responseBinaryContentTypes.size === 0
        ? []
        : [
            "Binary responses return an object with mimeType and base64-encoded dataBase64.",
          ]),
    ]
      .filter((part) => part !== undefined)
      .join("\n\n"),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly || METHOD_IDEMPOTENT[method],
      openWorldHint: true,
    },
  };
};

export const analyzeOpenApi = (
  value: unknown,
  options: CompileOptions = {},
): OperationCatalog => {
  if (
    typeof value === "object" &&
    value !== null &&
    "swagger" in value &&
    !("openapi" in value)
  ) {
    throw new OpenApiError({
      message:
        "Swagger documents are not supported; use OpenAPI 3.0, 3.1 or 3.2.",
    });
  }
  const parsed = Schema.decodeUnknownResult(OPENAPI_SCHEMA)(value);
  if (Result.isFailure(parsed)) {
    throw new OpenApiError({
      message: `Invalid OpenAPI document: ${parsed.failure.message}`,
    });
  }
  const document = parsed.success;
  const importParameters = makeParameterImporter(
    document.components.schemas,
    document.openapi,
    document.openapi.startsWith("3.0.")
      ? undefined
      : document.jsonSchemaDialect,
  );
  const operations: OperationDescriptor[] = [];
  const unsupported: OperationDiagnostic[] = [];
  const filtered: OperationDiagnostic[] = [];
  const names = new Set<string>();
  const methods = options.methods ?? [];
  const tags = options.tags ?? [];
  for (const [path, item] of Object.entries(document.paths).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (item.$ref !== undefined) {
      throw new OpenApiError({
        message: "Referenced path items are not supported.",
      });
    }
    for (const [method, operation] of Object.entries(
      item.additionalOperations,
    ).sort(([a], [b]) => a.localeCompare(b))) {
      if (methods.length > 0) {
        filtered.push({
          method,
          path,
          reason: "Excluded by the method filter.",
        });
        continue;
      }
      if (
        tags.length > 0 &&
        !operation.tags.some((tag) => tags.includes(tag))
      ) {
        filtered.push({ method, path, reason: "Excluded by the tag filter." });
        continue;
      }
      unsupported.push({
        method,
        path,
        reason: !document.openapi.startsWith("3.2.")
          ? "additionalOperations requires OpenAPI 3.2."
          : HTTP_METHODS.some((standard) => standard.toUpperCase() === method)
            ? `Method ${method} must use its fixed Path Item field.`
            : "Custom HTTP methods are not supported by the HTTP client.",
      });
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) {
        continue;
      }
      if (methods.length > 0 && !methods.includes(method)) {
        filtered.push({
          method,
          path,
          reason: "Excluded by the method filter.",
        });
        continue;
      }
      if (
        tags.length > 0 &&
        !operation.tags.some((tag) => tags.includes(tag))
      ) {
        filtered.push({ method, path, reason: "Excluded by the tag filter." });
        continue;
      }
      try {
        const descriptor = compileOperation(
          document,
          method,
          path,
          operation,
          item,
          options,
          importParameters,
        );
        if (names.has(descriptor.name)) {
          throw new OpenApiError({
            message: `Duplicate MCP tool name: ${descriptor.name}`,
          });
        }
        names.add(descriptor.name);
        operations.push(descriptor);
      } catch (error) {
        if (!(error instanceof UnsupportedOperationError)) {
          throw error;
        }
        unsupported.push({ method, path, reason: error.message });
      }
    }
  }
  return { operations, unsupported, filtered };
};

export const compileOpenApi = (
  value: unknown,
  options: CompileOptions = {},
): OperationCatalog => {
  const catalog = analyzeOpenApi(value, options);
  if (catalog.operations.length === 0) {
    const diagnostics = [...catalog.filtered, ...catalog.unsupported];
    throw new OpenApiError({
      message: `The OpenAPI document has no supported operations (${catalog.filtered.length} filtered, ${catalog.unsupported.length} unsupported).${diagnostics.length === 0 ? "" : ` ${diagnostics.map((item) => `${item.method.toUpperCase()} ${item.path}: ${item.reason}`).join("; ")}`}`,
    });
  }
  return catalog;
};
