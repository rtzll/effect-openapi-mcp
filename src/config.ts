import {
  isRequestHeaderName,
  isRequestHeaderValue,
} from "./request-headers.ts";
import {
  Config,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  DEFAULT_MAX_SPEC_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
} from "./bounded-text.ts";
import { HTTP_METHODS } from "./openapi-types.ts";
import {
  DEFAULT_PARAMETER_PROFILE,
  PARAMETER_PROFILE_SCHEMA,
} from "./parameter-profile.ts";

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<
  Readonly<{ message: string }>
> {}
const NonBlank = Schema.Trim.check(Schema.isMinLength(1));
export const CREDENTIALS_SCHEMA = Schema.Record(
  NonBlank,
  Schema.RedactedFromValue(
    Schema.NonEmptyString.check(
      Schema.isPattern(/\S/),
      Schema.isPattern(/^[^\r\n]+$/),
    ),
  ),
);
export type Credentials = typeof CREDENTIALS_SCHEMA.Type;
const NO_CREDENTIALS: Credentials = {};
export const DEFAULT_SPEC_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_REFERENCE_DOCUMENTS = 128;
export const DEFAULT_MAX_REFERENCE_DEPTH = 64;
export const REFERENCE_MODES = ["none", "local", "same-origin"] as const;
export type ReferencesMode = (typeof REFERENCE_MODES)[number];

export const normalizeBaseUrl = (value: URL): URL => {
  if (value.username !== "" || value.password !== "") {
    throw new Error("API server URLs must not contain credentials.");
  }
  if (value.search !== "" || value.hash !== "") {
    throw new Error("API server URLs must not contain a query or fragment.");
  }
  if (value.protocol !== "https:") {
    if (
      value.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(value.hostname)
    ) {
      throw new Error("API server URLs must use HTTPS, or HTTP on loopback.");
    }
  }
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
};
const readField = <A>(
  field: string,
  config: Config.Config<A>,
  expected: string,
) =>
  config.pipe(
    Effect.mapError(
      () =>
        new ConfigurationError({
          message: `Invalid configuration: ${field}. Expected ${expected}.`,
        }),
    ),
  );
const byteLimit = (name: string, defaultValue: number) =>
  readField(
    name,
    Config.schema(
      Schema.NumberFromString.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 * 1024 }),
      ),
      name,
    ).pipe(Config.withDefault(defaultValue)),
    "an integer from 1 to 1073741824 bytes",
  );
export const CONFIGURATION = Effect.gen(function* () {
  const openApiSpec = yield* readField(
    "MCP_OPENAPI_SPEC",
    Config.schema(NonBlank, "MCP_OPENAPI_SPEC"),
    "a nonblank file path or HTTPS URL (HTTP is allowed on loopback)",
  );
  const target = yield* readField(
    "MCP_API_BASE_URL",
    Config.option(Config.URL("MCP_API_BASE_URL")),
    "an HTTPS URL or loopback HTTP URL without credentials, query or fragment",
  );
  const baseUrl = yield* Effect.try({
    try: () => Option.map(target, normalizeBaseUrl),
    catch: () =>
      new ConfigurationError({
        message:
          "Invalid configuration: MCP_API_BASE_URL. Expected an HTTPS URL or loopback HTTP URL without credentials, query or fragment.",
      }),
  });
  const credentials = yield* readField(
    "MCP_CREDENTIALS",
    Config.schema(
      Schema.fromJsonString(CREDENTIALS_SCHEMA),
      "MCP_CREDENTIALS",
    ).pipe(Config.withDefault(NO_CREDENTIALS)),
    "a JSON object mapping nonblank security scheme names to nonblank, single-line credential strings",
  );
  const requestHeaders = yield* readField(
    "MCP_REQUEST_HEADERS",
    Config.schema(
      Schema.fromJsonString(CREDENTIALS_SCHEMA),
      "MCP_REQUEST_HEADERS",
    ).pipe(Config.withDefault(NO_CREDENTIALS)),
    "a JSON object of fixed request headers",
  );
  const toolHeaders = yield* readField(
    "MCP_TOOL_HEADERS",
    Config.schema(
      Schema.fromJsonString(Schema.Array(NonBlank)),
      "MCP_TOOL_HEADERS",
    ).pipe(Config.withDefault([])),
    "a JSON array of optional per-call header names",
  );
  if (
    Object.entries(requestHeaders).some(
      ([name, value]) =>
        !isRequestHeaderName(name) ||
        !isRequestHeaderValue(Redacted.value(value)),
    ) ||
    toolHeaders.some((name) => !isRequestHeaderName(name)) ||
    new Set(toolHeaders.map((name) => name.toLowerCase())).size !==
      toolHeaders.length
  )
    return yield* new ConfigurationError({
      message:
        "Invalid request headers: use distinct non-reserved names and nonblank printable ASCII values without surrounding whitespace.",
    });
  const methods = yield* readField(
    "MCP_METHODS",
    Config.schema(
      Schema.fromJsonString(Schema.Array(Schema.Literals(HTTP_METHODS))),
      "MCP_METHODS",
    ).pipe(Config.withDefault([])),
    `a JSON array of HTTP methods: ${HTTP_METHODS.join(", ")}`,
  );
  const tags = yield* readField(
    "MCP_TAGS",
    Config.schema(
      Schema.fromJsonString(Schema.Array(NonBlank)),
      "MCP_TAGS",
    ).pipe(Config.withDefault([])),
    "a JSON array of nonblank tag strings",
  );
  const port = yield* readField(
    "PORT",
    Config.schema(
      Schema.NumberFromString.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 65535 }),
      ),
      "PORT",
    ).pipe(Config.withDefault(3000)),
    "an integer from 1 to 65535",
  );
  const timeoutMs = yield* readField(
    "MCP_TIMEOUT_MS",
    Config.schema(
      Schema.NumberFromString.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 2147483647 }),
      ),
      "MCP_TIMEOUT_MS",
    ).pipe(Config.withDefault(10_000)),
    "an integer from 1 to 2147483647 milliseconds",
  );
  const specTimeoutMs = yield* readField(
    "MCP_SPEC_TIMEOUT_MS",
    Config.schema(
      Schema.NumberFromString.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 2147483647 }),
      ),
      "MCP_SPEC_TIMEOUT_MS",
    ).pipe(Config.withDefault(DEFAULT_SPEC_TIMEOUT_MS)),
    "an integer from 1 to 2147483647 milliseconds",
  );
  const maxSpecBytes = yield* byteLimit(
    "MCP_MAX_SPEC_BYTES",
    DEFAULT_MAX_SPEC_BYTES,
  );
  const referencesMode = yield* readField(
    "MCP_REFERENCES_MODE",
    Config.schema(Schema.Literals(REFERENCE_MODES), "MCP_REFERENCES_MODE").pipe(
      Config.withDefault("none"),
    ),
    '"none", "local" or "same-origin"',
  );
  const maxReferenceDocuments = yield* readField(
    "MCP_MAX_REFERENCE_DOCUMENTS",
    Config.schema(
      Schema.NumberFromString.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 4096 }),
      ),
      "MCP_MAX_REFERENCE_DOCUMENTS",
    ).pipe(Config.withDefault(DEFAULT_MAX_REFERENCE_DOCUMENTS)),
    "an integer from 1 to 4096 documents",
  );
  const maxReferenceDepth = yield* readField(
    "MCP_MAX_REFERENCE_DEPTH",
    Config.schema(
      Schema.NumberFromString.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 256 }),
      ),
      "MCP_MAX_REFERENCE_DEPTH",
    ).pipe(Config.withDefault(DEFAULT_MAX_REFERENCE_DEPTH)),
    "an integer from 1 to 256 reference steps",
  );
  const maxResponseBytes = yield* byteLimit(
    "MCP_MAX_RESPONSE_BYTES",
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const maxRequestBytes = yield* byteLimit(
    "MCP_MAX_REQUEST_BYTES",
    DEFAULT_MAX_REQUEST_BYTES,
  );
  const transport = yield* readField(
    "MCP_TRANSPORT",
    Config.schema(Schema.Literals(["http", "stdio"]), "MCP_TRANSPORT").pipe(
      Config.withDefault("http"),
    ),
    '"http" or "stdio"',
  );
  const parameterProfile = yield* readField(
    "MCP_PARAMETER_PROFILE",
    Config.schema(PARAMETER_PROFILE_SCHEMA, "MCP_PARAMETER_PROFILE").pipe(
      Config.withDefault(DEFAULT_PARAMETER_PROFILE),
    ),
    '"spec" or "brackets-indexed"',
  );
  return {
    openApiSpec,
    ...(Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
    ...(toolHeaders.length > 0 ? { toolHeaders } : {}),
    baseUrl,
    credentials,
    methods,
    tags,
    port,
    timeoutMs,
    specTimeoutMs,
    maxSpecBytes,
    referencesMode,
    maxReferenceDocuments,
    maxReferenceDepth,
    maxResponseBytes,
    maxRequestBytes,
    transport,
    parameterProfile,
  };
});
export type Configuration = Effect.Success<typeof CONFIGURATION>;
export class AdapterConfig extends Context.Service<
  AdapterConfig,
  Configuration
>()("openapi-mcp/Config") {
  static layer = Layer.effect(AdapterConfig, CONFIGURATION);
}
