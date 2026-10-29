import {
  isRequestHeaderName,
  isRequestHeaderValue,
} from "./request-headers.ts";
import {
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { encodeFormBody } from "./form.ts";
import { encodeMultipartBody } from "./multipart.ts";
import {
  encodeParameter,
  encodeStyled,
  MAX_BRACKET_BYTES,
  MAX_BRACKET_PAIRS,
} from "./parameter-encoding.ts";
import { wireNamespace } from "./parameter-profile.ts";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  readBoundedText,
  TextReadError,
} from "./bounded-text.ts";
import {
  binaryMediaEssence,
  isJsonMediaType,
  textResponseMediaEssence,
} from "./media-type.ts";
import { ByteReadError, readBoundedBytes } from "./bounded-bytes.ts";
import {
  ApiRejected,
  InvalidArguments,
  InvalidResponse,
  NetworkFailure,
  RateLimited,
  TimedOut,
  type ApiFailure,
} from "./api-errors.ts";
import { AdapterConfig } from "./config.ts";
import type { JsonValue, HttpMethod } from "./openapi-types.ts";
import type { OperationDescriptor } from "./openapi.ts";
import type { OperationArguments, ScalarParameterValue } from "./schema.ts";

const errorMessage = (status: number): string =>
  `The API rejected the request (HTTP ${status}).`;
const JSON_RESPONSE = Schema.fromJsonString(Schema.MutableJson);
const responseReadFailure = (error: unknown, fallback: string) =>
  new InvalidResponse({
    message:
      error instanceof TextReadError
        ? error.reason === "size"
          ? "The API response exceeded the configured byte limit."
          : "The API returned invalid UTF-8."
        : fallback,
  });

const scalar = (value: ScalarParameterValue): string => `${value}`;
const encode = encodeParameter;
const parameterValue = <T>(
  group: Readonly<Record<string, T>> | undefined,
  name: string,
): T | undefined =>
  group !== undefined && Object.hasOwn(group, name) ? group[name] : undefined;

const METHODS = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
  trace: "TRACE",
  query: "QUERY",
} as const satisfies Record<HttpMethod, string>;
export const makeApiClient = (
  httpClient: HttpClient.HttpClient,
  timeoutMs = 10_000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  requestHeaders: Readonly<Record<string, Redacted.Redacted<string>>> = {},
) => {
  const serialize = (
    operation: OperationDescriptor,
    arguments_: OperationArguments,
  ) => {
    let path = operation.path;
    const query = new Map<string, string[]>();
    const queryOwners = new Map<string, string>();
    const queryNamespaces = new Map<string, Set<string>>();
    const profileNamespaces = new Set<string>();
    const boundedQuery = operation.parameters.some(
      (parameter) =>
        parameter.location === "query" &&
        parameter.encoding.profile === "brackets-indexed",
    );
    const headers = new Headers({
      Accept: operation.responseContentTypes.join(", ") || "application/json",
    });
    for (const [name, secret] of Object.entries(requestHeaders)) {
      const value = Redacted.value(secret);
      if (
        !isRequestHeaderName(name) ||
        !isRequestHeaderValue(value) ||
        operation.authentication.some(
          (binding) =>
            binding.location === "header" &&
            binding.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw new InvalidArguments({
          message:
            "Configured request header conflicts with authentication/transport or has an invalid value.",
        });
      headers.set(name, value);
    }
    for (const parameter of operation.parameters) {
      if (parameter.location === "path") {
        const value = parameterValue(arguments_.path, parameter.name);
        if (value === undefined) {
          continue;
        }
        const segment = scalar(value);
        if (segment === "" || segment === "." || segment === "..") {
          throw new InvalidArguments({
            message: "Path parameters must be non-empty path segments.",
          });
        }
        path = path.replaceAll(`{${parameter.name}}`, encode(segment));
      } else if (parameter.location === "query") {
        const value = parameterValue(arguments_.query, parameter.name);
        if (value === undefined || value === null) {
          continue;
        }
        for (const [key, encoded] of encodeStyled(
          parameter.name,
          value,
          parameter.encoding,
        )) {
          const namespace = wireNamespace(key);
          const owners = queryNamespaces.get(namespace) ?? new Set<string>();
          const profiled = parameter.encoding.profile === "brackets-indexed";
          if (
            (profiled || profileNamespaces.has(namespace)) &&
            [...owners].some((owner) => owner !== parameter.name)
          ) {
            throw new InvalidArguments({
              message: "Query parameters have conflicting bracket namespaces.",
            });
          }
          owners.add(parameter.name);
          queryNamespaces.set(namespace, owners);
          if (profiled) profileNamespaces.add(namespace);
          const owner = queryOwners.get(key);
          if (owner !== undefined && owner !== parameter.name) {
            throw new InvalidArguments({
              message: "Expanded query parameters have conflicting wire names.",
            });
          }
          queryOwners.set(key, parameter.name);
          const values = query.get(key) ?? [];
          values.push(encoded);
          query.set(key, values);
        }
      } else if (parameter.location === "header") {
        const value = parameterValue(arguments_.headers, parameter.name);
        if (value === undefined) {
          continue;
        }
        if (
          Array.isArray(value) &&
          value.some((item) => scalar(item).includes(","))
        ) {
          throw new InvalidArguments({
            message: "Header array items must not contain comma delimiters.",
          });
        }
        const encoded = Array.isArray(value)
          ? value.map(scalar).join(",")
          : scalar(value);
        headers.set(parameter.name, encoded);
        if (headers.get(parameter.name) !== encoded) {
          throw new InvalidArguments({
            message:
              "Header values must not contain leading or trailing HTTP whitespace.",
          });
        }
      } else {
        const location: never = parameter.location;
        throw new Error("Unknown parameter location.", { cause: location });
      }
    }
    // An explicit relative prefix keeps first-segment colons from becoming URL schemes.
    const url = new URL(`.${path}`, operation.baseUrl);
    if (!url.href.startsWith(operation.baseUrl.href)) {
      throw new InvalidArguments({
        message: "The request path escapes the configured API base URL.",
      });
    }
    for (const binding of operation.authentication) {
      if (binding.location === "header") {
        headers.set(binding.name, Redacted.value(binding.value));
      } else if (binding.location === "query") {
        if (
          query.has(binding.name) ||
          profileNamespaces.has(wireNamespace(binding.name))
        ) {
          throw new InvalidArguments({
            message: "Expanded query parameters conflict with authentication.",
          });
        }
        query.set(binding.name, [encode(Redacted.value(binding.value))]);
      } else {
        const location: never = binding.location;
        throw new Error("Unknown authentication location.", {
          cause: location,
        });
      }
    }
    const queryParts: string[] = [];
    let queryBytes = 0;
    for (const [name, values] of query) {
      const key = encode(name);
      for (const value of values) {
        // URI escaping produces ASCII, so encoded bytes equal the string length.
        queryBytes +=
          key.length + 1 + value.length + (queryParts.length > 0 ? 1 : 0);
        if (
          boundedQuery &&
          (queryParts.length >= MAX_BRACKET_PAIRS ||
            queryBytes > MAX_BRACKET_BYTES)
        ) {
          throw new InvalidArguments({
            message:
              "The profiled query exceeds its pair or encoded byte limit.",
          });
        }
        queryParts.push(`${key}=${value}`);
      }
    }
    url.search = queryParts.join("&");
    // URL objects are normalized through URLSearchParams, which loses encoded array delimiters.
    const request = HttpClientRequest.make(METHODS[operation.method])(
      url.href,
      {
        headers,
      },
    );
    if (arguments_.body === undefined) {
      return request;
    }
    if (operation.body === undefined) {
      throw new InvalidArguments({
        message: "This operation does not accept a request body.",
      });
    }
    if (operation.body.mode === "multipart") {
      const encoded = encodeMultipartBody(
        arguments_.body,
        operation.body.multipart,
        maxRequestBytes,
      );
      return HttpClientRequest.bodyUint8Array(
        request,
        encoded.bytes,
        encoded.contentType,
      );
    }
    if (operation.body.mode === "text") {
      if (typeof arguments_.body !== "string") {
        throw new InvalidArguments({
          message: "Text request bodies must be strings.",
        });
      }
      if (!arguments_.body.isWellFormed()) {
        throw new InvalidArguments({
          message: "Text request bodies must be well-formed Unicode.",
        });
      }
      if (Buffer.byteLength(arguments_.body, "utf8") > maxRequestBytes) {
        throw new InvalidArguments({
          message: "The text request body exceeded the configured byte limit.",
        });
      }
      return HttpClientRequest.bodyText(
        request,
        arguments_.body,
        operation.body.contentType,
      );
    }
    const encoded =
      operation.body.mode === "json"
        ? JSON.stringify(arguments_.body)
        : encodeFormBody(arguments_.body, operation.body.form);
    if (Buffer.byteLength(encoded, "utf8") > maxRequestBytes) {
      throw new InvalidArguments({
        message: "The request body exceeded the configured byte limit.",
      });
    }
    return HttpClientRequest.bodyText(
      request,
      encoded,
      operation.body.contentType,
    );
  };
  const execute = Effect.fn("openapi.request")(
    function* (
      operation: OperationDescriptor,
      arguments_: OperationArguments,
    ): Effect.fn.Return<JsonValue, ApiFailure, Scope.Scope> {
      yield* Effect.annotateCurrentSpan({
        "openapi.operation": operation.name,
        "http.request.method": METHODS[operation.method],
      });
      const request = yield* Effect.try({
        try: () => serialize(operation, arguments_),
        catch: (error) =>
          error instanceof InvalidArguments
            ? error
            : new InvalidArguments({
                message: "Could not encode the tool arguments.",
              }),
      });
      const response = yield* HttpClient.withScope(httpClient)
        .execute(request)
        .pipe(
          Effect.mapError(
            () =>
              new NetworkFailure({
                message: "The API could not be reached. Retry later.",
              }),
          ),
        );
      yield* Effect.annotateCurrentSpan(
        "http.response.status_code",
        response.status,
      );
      if (response.status === 429) {
        return yield* new RateLimited({
          message: errorMessage(429),
          retryAfter: Option.fromUndefinedOr(response.headers["retry-after"]),
        });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new ApiRejected({
          message: errorMessage(response.status),
          status: response.status,
        });
      }
      if (
        operation.method === "head" ||
        response.status === 204 ||
        response.status === 205
      ) {
        return null;
      }
      const responseKey = Object.hasOwn(
        operation.responses,
        `${response.status}`,
      )
        ? `${response.status}`
        : Object.hasOwn(operation.responses, "2XX")
          ? "2XX"
          : "default";
      const responseMode = operation.responses[responseKey];
      if (responseMode === "empty") {
        const text = yield* readBoundedText(
          response.stream,
          maxResponseBytes,
        ).pipe(
          Effect.mapError((error) =>
            responseReadFailure(error, "The API response could not be read."),
          ),
        );
        if (text === "") {
          return null;
        }
        return yield* new InvalidResponse({
          message: "The API returned a body for a content-free response.",
        });
      }
      const contentType = response.headers["content-type"];
      if (responseMode === "binary") {
        const actual =
          contentType === undefined
            ? undefined
            : binaryMediaEssence(contentType);
        const declared = operation.responseBinaryContentTypes?.[responseKey];
        if (
          actual === undefined ||
          declared === undefined ||
          !declared.some((type) => binaryMediaEssence(type) === actual)
        ) {
          return yield* new InvalidResponse({
            message: "The API returned an unsupported response media type.",
          });
        }
        const bytes = yield* readBoundedBytes(
          response.stream,
          maxResponseBytes,
        ).pipe(
          Effect.mapError(
            (error) =>
              new InvalidResponse({
                message:
                  error instanceof ByteReadError
                    ? "The API response exceeded the configured byte limit."
                    : "The API response could not be read.",
              }),
          ),
        );
        return {
          mimeType: actual,
          dataBase64: Buffer.from(bytes).toString("base64"),
        };
      }
      if (responseMode === "text") {
        const actual =
          contentType === undefined
            ? undefined
            : textResponseMediaEssence(contentType);
        const declared = operation.responseTextContentTypes?.[responseKey];
        if (
          actual === undefined ||
          declared === undefined ||
          !declared.some((type) => textResponseMediaEssence(type) === actual)
        ) {
          return yield* new InvalidResponse({
            message: "The API returned an unsupported response media type.",
          });
        }
        return yield* readBoundedText(response.stream, maxResponseBytes, {
          preserveBOM: true,
        }).pipe(
          Effect.mapError((error) =>
            responseReadFailure(error, "The API response could not be read."),
          ),
        );
      }
      if (contentType === undefined || !isJsonMediaType(contentType)) {
        return yield* new InvalidResponse({
          message: "The API returned an unsupported response media type.",
        });
      }
      return yield* readBoundedText(response.stream, maxResponseBytes).pipe(
        Effect.flatMap(Schema.decodeEffect(JSON_RESPONSE)),
        Effect.mapError((error) =>
          responseReadFailure(
            error,
            "The API returned an invalid JSON response.",
          ),
        ),
      );
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new TimedOut({ message: "The API request timed out. Retry later." }),
        ),
    }),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provideService(HttpClient.TracerHeaderFilter, () => false),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    // Automatic HTTP spans end before mapError sanitizes transport causes.
    // Keep the openapi.request span, which records only safe failures and metadata.
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  );
  return { execute };
};
export type ApiClient = ReturnType<typeof makeApiClient>;
export class HttpApi extends Context.Service<HttpApi, ApiClient>()(
  "openapi-mcp/HttpApi",
) {
  static layer = Layer.effect(
    HttpApi,
    Effect.gen(function* () {
      const configuration = yield* AdapterConfig;
      return makeApiClient(
        yield* HttpClient.HttpClient,
        configuration.timeoutMs,
        configuration.maxResponseBytes,
        configuration.maxRequestBytes,
        configuration.requestHeaders,
      );
    }),
  );
}
export const structuredResult = (value: JsonValue) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : { result: value };
