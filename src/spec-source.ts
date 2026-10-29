import { dirname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, FileSystem, PlatformError, Ref, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";
import { parseDocument } from "yaml";
import {
  DEFAULT_SPEC_TIMEOUT_MS,
  normalizeBaseUrl,
  type ReferencesMode,
} from "./config.ts";
import { SpecLoadError } from "./openapi-errors.ts";
import {
  DEFAULT_MAX_SPEC_BYTES,
  readBoundedText,
  TextReadError,
} from "./bounded-text.ts";
import type { JsonValue } from "./openapi-types.ts";

export const parseOpenApi = (text: string): JsonValue => {
  const document = parseDocument(text, {
    version: "1.2",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("Invalid OpenAPI document.");
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  return Schema.decodeUnknownSync(Schema.MutableJson)(value);
};

export type SpecSourceOptions = Readonly<{
  maxSpecBytes?: number;
  specTimeoutMs?: number;
  referencesMode?: ReferencesMode;
}>;
export type SpecSource = Readonly<{
  entry: JsonValue;
  retrievalUri: URL;
  sourceUrl: URL | undefined;
  loadDocument: (source: URL) => Effect.Effect<JsonValue, SpecLoadError>;
}>;

const sizeFailure = () =>
  new SpecLoadError({
    reason: "size",
    message: "The OpenAPI document graph exceeds MCP_MAX_SPEC_BYTES.",
  });
const urlFailure = () =>
  new SpecLoadError({
    reason: "url",
    message:
      "Invalid OpenAPI source URL or reference location. Check the source and MCP_REFERENCES_MODE policy.",
  });
const localFailure = (error: PlatformError.PlatformError): SpecLoadError => {
  switch (error.reason._tag) {
    case "NotFound":
      return new SpecLoadError({
        reason: "missing",
        message:
          "The OpenAPI file was not found. Check MCP_OPENAPI_SPEC and referenced files.",
      });
    case "PermissionDenied":
      return new SpecLoadError({
        reason: "permission",
        message:
          "Permission denied reading the OpenAPI file. Check file permissions.",
      });
    case "TimedOut":
      return new SpecLoadError({
        reason: "timeout",
        message:
          "Reading the OpenAPI file timed out. Check the source availability.",
      });
    default:
      return new SpecLoadError({
        reason: "read",
        message:
          "Could not read the OpenAPI file. Check MCP_OPENAPI_SPEC and referenced files.",
      });
  }
};
const textFailure = (error: TextReadError): SpecLoadError =>
  error.reason === "size"
    ? sizeFailure()
    : new SpecLoadError({
        reason: "utf8",
        message: "The OpenAPI document contains invalid UTF-8.",
      });

const parseText = (text: string) =>
  Effect.try({
    try: () => parseOpenApi(text),
    catch: () =>
      new SpecLoadError({
        reason: "syntax",
        message: "Invalid OpenAPI JSON/YAML document.",
      }),
  });
const validateRemoteUrl = (source: URL) =>
  Effect.try({
    try: () => {
      normalizeBaseUrl(source);
      return source;
    },
    catch: () =>
      new SpecLoadError({
        reason: "url",
        message:
          "Invalid OpenAPI URL. Expected HTTPS or loopback HTTP without credentials, query or fragment.",
      }),
  });
const nativeFilePath = (source: URL) =>
  Effect.try({
    try: () => {
      if (
        source.protocol !== "file:" ||
        source.search !== "" ||
        source.hash !== ""
      ) {
        throw new Error("Invalid file URI");
      }
      return fileURLToPath(source);
    },
    catch: urlFailure,
  });
const insideDirectory = (directory: string, file: string): boolean => {
  const path = relative(directory, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

// Allocate budget and capture services inside each evaluation; dependencies share exactly one budget.
export const withSpecSource = <A, E, R>(
  location: string,
  options: SpecSourceOptions,
  use: (source: SpecSource) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | SpecLoadError,
  R | FileSystem.FileSystem | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;
    const maxBytes = options.maxSpecBytes ?? DEFAULT_MAX_SPEC_BYTES;
    const budget = yield* Ref.make(maxBytes);
    const charge = (chunk: Uint8Array) =>
      Ref.modify(budget, (remaining) =>
        chunk.byteLength <= remaining
          ? ([true, remaining - chunk.byteLength] as const)
          : ([false, 0] as const),
      ).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Effect.fail(sizeFailure()),
        ),
      );
    const readText = <E1, R1>(stream: Stream.Stream<Uint8Array, E1, R1>) =>
      readBoundedText(stream.pipe(Stream.tap(charge)), maxBytes);
    const readLocal = (path: string) =>
      readText(fs.stream(path)).pipe(
        Effect.mapError((error) =>
          error instanceof SpecLoadError
            ? error
            : error instanceof TextReadError
              ? textFailure(error)
              : localFailure(error),
        ),
      );
    const readRemote = (source: URL) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.withScope(http).get(source);
        if (response.status < 200 || response.status >= 300) {
          return yield* new SpecLoadError({
            reason: "httpStatus",
            message: `The OpenAPI server returned HTTP ${response.status}.`,
          });
        }
        return yield* readText(response.stream);
      }).pipe(
        Effect.scoped,
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "error",
          credentials: "omit",
        }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError((error) => {
          if (error instanceof SpecLoadError) return error;
          if (error instanceof TextReadError) return textFailure(error);
          if (error.reason instanceof HttpClientError.InvalidUrlError)
            return urlFailure();
          if (error.reason instanceof HttpClientError.StatusCodeError) {
            return new SpecLoadError({
              reason: "httpStatus",
              message: `The OpenAPI server returned HTTP ${error.reason.response.status}.`,
            });
          }
          return new SpecLoadError({
            reason: "network",
            message:
              "Could not reach or read the OpenAPI server. Check network connectivity.",
          });
        }),
      );
    // Native Windows absolute paths contain a colon but are not URL schemes.
    const isUrl =
      !/^[a-z]:[\\/]/i.test(location) &&
      (URL.canParse(location) || /^[a-z][a-z\d+.-]*:/i.test(location));
    const configuredUrl = isUrl
      ? yield* Effect.try({ try: () => new URL(location), catch: urlFailure })
      : undefined;
    const remote =
      configuredUrl !== undefined && configuredUrl.protocol !== "file:"
        ? yield* validateRemoteUrl(configuredUrl)
        : undefined;
    const retrieval =
      remote === undefined
        ? yield* Effect.gen(function* () {
            const file =
              configuredUrl === undefined
                ? location
                : yield* nativeFilePath(configuredUrl);
            const canonical = yield* fs
              .realPath(file)
              .pipe(Effect.mapError(localFailure));
            return {
              kind: "local" as const,
              file: canonical,
              directory: dirname(canonical),
              uri: pathToFileURL(canonical),
            };
          })
        : { kind: "remote" as const, uri: remote };
    const entryText =
      retrieval.kind === "local"
        ? yield* readLocal(retrieval.file)
        : yield* readRemote(retrieval.uri);
    const entry = yield* parseText(entryText);
    const loadDocument = (
      source: URL,
    ): Effect.Effect<JsonValue, SpecLoadError> =>
      Effect.gen(function* () {
        if ((options.referencesMode ?? "none") === "none")
          return yield* urlFailure();
        if (retrieval.kind === "local") {
          const file = yield* nativeFilePath(source);
          const canonical = yield* fs
            .realPath(file)
            .pipe(Effect.mapError(localFailure));
          if (!insideDirectory(retrieval.directory, canonical))
            return yield* urlFailure();
          return yield* parseText(yield* readLocal(canonical));
        }
        if (
          options.referencesMode !== "same-origin" ||
          source.origin !== retrieval.uri.origin
        )
          return yield* urlFailure();
        const url = yield* validateRemoteUrl(source);
        return yield* parseText(yield* readRemote(url));
      });
    return yield* use({
      entry,
      retrievalUri: retrieval.uri,
      sourceUrl: retrieval.kind === "remote" ? retrieval.uri : undefined,
      loadDocument,
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.specTimeoutMs ?? DEFAULT_SPEC_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new SpecLoadError({
            reason: "timeout",
            message:
              "Loading the OpenAPI document graph timed out. Check MCP_SPEC_TIMEOUT_MS and the source availability.",
          }),
        ),
    }),
  );
