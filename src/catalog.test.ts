import { dirname, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/http";
import { expect, it } from "@effect/vitest";
import { inspectOperationCatalog, loadOperationCatalog } from "./catalog.ts";
import { OpenApiError, SpecLoadError } from "./openapi-errors.ts";
import {
  accepts,
  API_RESPONSES,
  findOperation,
  INVENTORY_SPEC,
  TEST_CREDENTIALS,
} from "./test-fixtures.ts";

const documentFile = Effect.fnUntraced(function* (contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "openapi-mcp-",
  });
  const file = join(directory, "spec.yaml");
  yield* fs.writeFileString(file, contents);
  return file;
});

const SPLIT_ENTRY = JSON.stringify({
  openapi: "3.1.0",
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/first": { $ref: "./paths.json#/Item" },
    "/second": { $ref: "./paths.json#/Item" },
  },
});
const SPLIT_PATHS = JSON.stringify({
  Item: {
    get: {
      responses: API_RESPONSES,
      parameters: [
        {
          name: "filter",
          in: "query",
          schema: { $ref: "./types.json#/$defs/Filter" },
        },
      ],
    },
  },
});
const SPLIT_TYPES = JSON.stringify({
  $defs: { Filter: { type: "string", enum: ["active", "archived"] } },
});
const splitFiles = Effect.fnUntraced(function* () {
  const file = yield* documentFile(SPLIT_ENTRY);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(join(dirname(file), "paths.json"), SPLIT_PATHS);
  yield* fs.writeFileString(join(dirname(file), "types.json"), SPLIT_TYPES);
  return file;
});

it.layer(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer))(
  "OpenAPI loading",
  (it) => {
    it.effect("compiles a configured JSON file", () =>
      Effect.gen(function* () {
        const file = yield* documentFile(JSON.stringify(INVENTORY_SPEC));
        const catalog = yield* loadOperationCatalog(file, {
          credentials: TEST_CREDENTIALS,
        });
        expect(catalog.operations).toHaveLength(6);
      }),
    );
    it.effect.each([
      {
        selection: { methods: ["get"] },
        ref: "#/components/schemas/Missing",
        reason: "Excluded by the method filter.",
      },
      {
        selection: { methods: ["get"] },
        ref: "https://disallowed.example.com/private-schema.json",
        reason: "Excluded by the method filter.",
      },
      {
        selection: { tags: ["inventory"] },
        ref: "#/components/schemas/Missing",
        reason: "Excluded by the tag filter.",
      },
      {
        selection: { tags: ["inventory"] },
        ref: "https://disallowed.example.com/private-schema.json",
        reason: "Excluded by the tag filter.",
      },
    ] as const)(
      "skips reference work in filtered operations without losing their diagnostics (%s)",
      ({ selection, ref, reason }) =>
        Effect.gen(function* () {
          const document = JSON.stringify({
            openapi: "3.1.0",
            servers: [{ url: "https://api.example.com" }],
            paths: {
              "/items": {
                get: { tags: ["inventory"], responses: API_RESPONSES },
                post: {
                  tags: ["maintenance"],
                  requestBody: {
                    content: { "application/json": { schema: { $ref: ref } } },
                  },
                  responses: API_RESPONSES,
                },
              },
            },
          });
          const file = yield* documentFile(document);
          const fs = yield* FileSystem.FileSystem;
          let reads = 0;
          const http = HttpClient.make(() =>
            Effect.die("Filtered operations must not trigger spec requests."),
          );
          const catalog = yield* loadOperationCatalog(file, {
            ...selection,
            referencesMode: "local",
            maxReferenceDocuments: 1,
            maxSpecBytes: Buffer.byteLength(document),
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              stream: (path, options) => {
                reads++;
                return fs.stream(path, options);
              },
            }),
          );
          expect(catalog.operations.map((operation) => operation.name)).toEqual(
            ["get_items"],
          );
          expect(catalog.unsupported).toEqual([]);
          expect(catalog.filtered).toEqual([
            { method: "post", path: "/items", reason },
          ]);
          expect(reads).toBe(1);
        }),
    );
    it.effect(
      "loads split local paths and deep schema pointers with one cached read per document",
      () =>
        Effect.gen(function* () {
          const file = yield* splitFiles();
          const fs = yield* FileSystem.FileSystem;
          const reads: string[] = [];
          const total =
            Buffer.byteLength(SPLIT_ENTRY) +
            Buffer.byteLength(SPLIT_PATHS) +
            Buffer.byteLength(SPLIT_TYPES);
          const catalog = yield* loadOperationCatalog(file, {
            referencesMode: "local",
            maxSpecBytes: total,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              stream: (path, options) => {
                reads.push(path);
                return fs.stream(path, options);
              },
            }),
          );
          expect(catalog.operations.map((operation) => operation.name)).toEqual(
            ["get_first", "get_second"],
          );
          expect(reads).toHaveLength(3);
          expect(new Set(reads).size).toBe(3);
          const operation = findOperation(catalog, "get_first");
          expect(accepts(operation, { query: { filter: "active" } })).toBe(
            true,
          );
          expect(accepts(operation, { query: { filter: "invalid" } })).toBe(
            false,
          );
          expect(
            yield* Effect.flip(
              loadOperationCatalog(file, {
                referencesMode: "local",
                maxSpecBytes: total - 1,
              }),
            ),
          ).toHaveProperty("reason", "size");
        }),
    );
    it.effect(
      "does not fetch external references unless explicitly enabled",
      () =>
        Effect.gen(function* () {
          const file = yield* splitFiles();
          const fs = yield* FileSystem.FileSystem;
          const reads: string[] = [];
          const failure = yield* Effect.flip(
            loadOperationCatalog(file).pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                stream: (path, options) => {
                  reads.push(path);
                  return fs.stream(path, options);
                },
              }),
            ),
          );
          expect(failure).toBeInstanceOf(OpenApiError);
          expect(reads).toHaveLength(1);
        }),
    );
    it.effect(
      "applies document and depth limits to local reference graphs",
      () =>
        Effect.gen(function* () {
          const file = yield* splitFiles();
          expect(
            yield* Effect.flip(
              loadOperationCatalog(file, {
                referencesMode: "local",
                maxReferenceDocuments: 2,
              }),
            ),
          ).toHaveProperty("reason", "documents");
          expect(
            yield* Effect.flip(
              loadOperationCatalog(file, {
                referencesMode: "local",
                maxReferenceDepth: 1,
              }),
            ),
          ).toHaveProperty("reason", "depth");
        }),
    );
    it.effect(
      "local file retrieval URIs do not become the base for relative API servers",
      () =>
        Effect.gen(function* () {
          const file = yield* documentFile(
            JSON.stringify({
              openapi: "3.1.0",
              servers: [{ url: "/v1" }],
              paths: { "/items": { get: { responses: API_RESPONSES } } },
            }),
          );
          expect(
            yield* Effect.flip(
              loadOperationCatalog(file, { referencesMode: "local" }),
            ),
          ).toBeInstanceOf(OpenApiError);
          const catalog = yield* loadOperationCatalog(file, {
            referencesMode: "local",
            baseUrl: new URL("https://api.example.com/v1/"),
          });
          expect(catalog.operations[0]?.baseUrl.href).toBe(
            "https://api.example.com/v1/",
          );
        }),
    );
    it.effect(
      "resolves relative API servers against the actual remote retrieval URL, independently of $self",
      () =>
        Effect.gen(function* () {
          const document = {
            openapi: "3.2.1",
            $self: "https://logical.example.com/definitions/root.json",
            servers: [{ url: "/v1" }],
            paths: { "/items": { get: { responses: API_RESPONSES } } },
          };
          const http = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(document)),
              ),
            ),
          );
          const catalog = yield* loadOperationCatalog(
            "https://retrieval.example.com/spec/root.json",
          ).pipe(Effect.provideService(HttpClient.HttpClient, http));
          expect(catalog.operations[0]?.baseUrl.href).toBe(
            "https://retrieval.example.com/v1/",
          );
        }),
    );
    it.effect(
      "inspection returns diagnostics when every operation is filtered",
      () =>
        Effect.gen(function* () {
          const file = yield* documentFile(JSON.stringify(INVENTORY_SPEC));
          const catalog = yield* inspectOperationCatalog(file, {
            tags: ["absent"],
          });
          expect(catalog.operations).toEqual([]);
          expect(catalog.filtered).toHaveLength(6);
          expect(catalog.unsupported).toEqual([]);
          const failure = yield* Effect.flip(
            loadOperationCatalog(file, { tags: ["absent"] }),
          );
          expect(failure).toBeInstanceOf(OpenApiError);
          expect(failure.message).toContain("6 filtered, 0 unsupported");
          expect(failure.message).toContain("Excluded by the tag filter");
        }),
    );
    it.effect("inspection accepts a valid document with no operations", () =>
      Effect.gen(function* () {
        const file = yield* documentFile('{"openapi":"3.2.1","paths":{}}');
        expect(yield* inspectOperationCatalog(file)).toEqual({
          operations: [],
          unsupported: [],
          filtered: [],
        });
      }),
    );
    it.effect.each([
      ['{"private":"upstream-secret"', "Invalid OpenAPI JSON/YAML document"],
      [
        JSON.stringify({ openapi: "2.0", paths: {} }),
        "Invalid OpenAPI document",
      ],
      [
        JSON.stringify({ openapi: "3.1.0", paths: {} }),
        "no supported operations",
      ],
    ] as const)(
      "reports invalid documents as typed startup failures (%s)",
      ([contents, message]) =>
        Effect.gen(function* () {
          const file = yield* documentFile(contents);
          const failure = yield* Effect.flip(loadOperationCatalog(file));
          expect(failure).toBeInstanceOf(
            contents.includes("upstream-secret") ? SpecLoadError : OpenApiError,
          );
          expect(failure.message).toContain(message);
          expect(JSON.stringify(failure)).not.toContain("upstream-secret");
        }),
    );
    it.effect("limits local document bytes before parsing", () =>
      Effect.gen(function* () {
        const contents = JSON.stringify(INVENTORY_SPEC);
        const file = yield* documentFile(contents);
        expect(
          (yield* loadOperationCatalog(file, {
            credentials: TEST_CREDENTIALS,
            maxSpecBytes: Buffer.byteLength(contents),
          })).operations,
        ).toHaveLength(6);
        const failure = yield* Effect.flip(
          loadOperationCatalog(file, {
            maxSpecBytes: Buffer.byteLength(contents) - 1,
          }),
        );
        expect(failure).toBeInstanceOf(SpecLoadError);
        expect(failure).toHaveProperty("reason", "size");
        expect(failure.message).toContain("MCP_MAX_SPEC_BYTES");
      }),
    );
    it.effect("rejects malformed UTF-8 rather than replacing bytes", () =>
      Effect.gen(function* () {
        const file = yield* documentFile("");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFile(file, new Uint8Array([0xff]));
        expect(yield* Effect.flip(loadOperationCatalog(file))).toBeInstanceOf(
          SpecLoadError,
        );
      }),
    );
    it.effect(
      "bounds remote documents even when Content-Length is misleading",
      () =>
        Effect.gen(function* () {
          let cancelled = false;
          const http = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode(
                          JSON.stringify(INVENTORY_SPEC),
                        ),
                      );
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
                  { headers: { "Content-Length": "1" } },
                ),
              ),
            ),
          );
          const failure = yield* Effect.flip(
            loadOperationCatalog("https://spec.example.com/openapi.json", {
              maxSpecBytes: 10,
            }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
          );
          expect(failure).toBeInstanceOf(SpecLoadError);
          expect(failure).toHaveProperty("reason", "size");
          expect(failure.message).toContain("MCP_MAX_SPEC_BYTES");
          expect(cancelled).toBe(true);
        }),
    );
    it.effect("reports unreadable files as typed failures", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          loadOperationCatalog("/missing/openapi.json"),
        );
        expect(failure).toBeInstanceOf(SpecLoadError);
        expect(failure).toHaveProperty("reason", "missing");
        expect(failure.message).toContain("not found");
      }),
    );
    it.effect.each([
      ["PermissionDenied", "permission"],
      ["Unknown", "read"],
      ["TimedOut", "timeout"],
    ] as const)(
      "classifies filesystem failures without leaking paths or causes (%s)",
      ([tag, reason]) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const failure = yield* Effect.flip(
            loadOperationCatalog("/private-file-with-secret", {}).pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                realPath: (path) => Effect.succeed(path),
                stream: () =>
                  Stream.fail(
                    PlatformError.systemError({
                      _tag: tag,
                      module: "FileSystem",
                      method: "stream",
                      pathOrDescriptor: "/private-file-with-secret",
                      cause: new Error("upstream-secret"),
                    }),
                  ),
              }),
            ),
          );
          expect(failure).toHaveProperty("reason", reason);
          expect(JSON.stringify(failure)).not.toContain(
            "private-file-with-secret",
          );
          expect(JSON.stringify(failure)).not.toContain("upstream-secret");
          expect(failure).not.toHaveProperty("cause");
        }),
    );
    it.effect.each([401, 404, 500])(
      "preserves a safe HTTP status diagnostic (%s)",
      (status) =>
        Effect.gen(function* () {
          const http = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("upstream-secret", { status }),
              ),
            ),
          );
          const failure = yield* Effect.flip(
            loadOperationCatalog(
              "https://spec.example.com/private-source",
              {},
            ).pipe(Effect.provideService(HttpClient.HttpClient, http)),
          );
          expect(failure).toHaveProperty("reason", "httpStatus");
          expect(failure.message).toContain(`HTTP ${status}`);
          expect(JSON.stringify(failure)).not.toContain("upstream-secret");
          expect(JSON.stringify(failure)).not.toContain("private-source");
        }),
    );
    it.effect(
      "maps native network failures without exposing requests or causes",
      () =>
        Effect.gen(function* () {
          const http = HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("upstream-secret"),
                }),
              }),
            ),
          );
          const failure = yield* Effect.flip(
            loadOperationCatalog(
              "https://spec.example.com/private-source",
              {},
            ).pipe(Effect.provideService(HttpClient.HttpClient, http)),
          );
          expect(failure).toHaveProperty("reason", "network");
          expect(JSON.stringify(failure)).not.toContain("private-source");
          expect(JSON.stringify(failure)).not.toContain("upstream-secret");
          expect(failure).not.toHaveProperty("cause");
        }),
    );
    it.effect(
      "uses the configured virtual-clock deadline and cancels an in-flight request",
      () =>
        Effect.gen(function* () {
          const started = Deferred.makeUnsafe<void>();
          let signal: AbortSignal | undefined;
          let interrupted = false;
          const http = HttpClient.make((_request, _url, abortSignal) => {
            signal = abortSignal;
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            );
          });
          const load = yield* loadOperationCatalog(
            "https://spec.example.com/openapi.json",
            { specTimeoutMs: 25 },
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.flip,
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          yield* TestClock.adjust(24);
          expect(signal?.aborted).toBe(false);
          yield* TestClock.adjust(1);
          const failure = yield* Fiber.join(load);
          expect(failure).toHaveProperty("reason", "timeout");
          expect(failure.message).toContain("MCP_SPEC_TIMEOUT_MS");
          expect(interrupted).toBe(true);
          expect(signal?.aborted).toBe(true);
        }),
    );
    it.effect(
      "bounds stalled local I/O with the same deadline and finalizes its stream",
      () =>
        Effect.gen(function* () {
          const started = Deferred.makeUnsafe<void>();
          let finalized = false;
          const fs = yield* FileSystem.FileSystem;
          const load = yield* loadOperationCatalog("/stalled-file", {
            specTimeoutMs: 10,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              realPath: (path) => Effect.succeed(path),
              stream: () =>
                Stream.fromEffect(
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                  ),
                ).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      finalized = true;
                    }),
                  ),
                ),
            }),
            Effect.flip,
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          yield* TestClock.adjust(10);
          expect(yield* Fiber.join(load)).toHaveProperty("reason", "timeout");
          expect(finalized).toBe(true);
        }),
    );
    it.effect(
      "the default deadline includes reading the remote response body",
      () =>
        Effect.gen(function* () {
          const started = Deferred.makeUnsafe<void>();
          let cancelled = false;
          let signal: AbortSignal | undefined;
          const http = HttpClient.make((request, _url, abortSignal) => {
            signal = abortSignal;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  new ReadableStream({
                    cancel() {
                      cancelled = true;
                    },
                  }),
                ),
              ),
            ).pipe(Effect.tap(() => Deferred.succeed(started, undefined)));
          });
          const load = yield* loadOperationCatalog(
            "https://spec.example.com/spec.json",
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.flip,
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          yield* TestClock.adjust(10_000);
          expect(yield* Fiber.join(load)).toHaveProperty("reason", "timeout");
          expect(cancelled).toBe(true);
          expect(signal?.aborted).toBe(true);
        }),
    );
    it.effect.each([
      "https://[",
      "ftp://spec.example.com/private-source",
      "http://spec.example.com/private-source",
      "https://spec.example.com/spec?key=upstream-secret",
      "https://spec.example.com/spec#upstream-secret",
    ])("classifies malformed and disallowed URLs safely (%s)", (location) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(loadOperationCatalog(location));
        expect(failure).toHaveProperty("reason", "url");
        expect(JSON.stringify(failure)).not.toContain("upstream-secret");
        expect(JSON.stringify(failure)).not.toContain("private-source");
      }),
    );
    it.effect("rejects URLs containing secrets without exposing them", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          loadOperationCatalog("https://private-key@api.example.com/spec.json"),
        );
        expect(failure).toBeInstanceOf(SpecLoadError);
        expect(failure).toHaveProperty("reason", "url");
        expect(failure.message).toContain("Invalid OpenAPI URL");
        expect(JSON.stringify(failure)).not.toContain("private-key");
      }),
    );
    it.effect("loads an OpenAPI YAML file without JSON conversion", () =>
      Effect.gen(function* () {
        const file = yield* documentFile(`openapi: 3.1.0
servers:
  - url: https://api.example.com
paths:
  /values:
    get:
      responses:
        '200':
          content:
            application/json: {}
`);
        expect((yield* loadOperationCatalog(file)).operations[0]?.name).toBe(
          "get_values",
        );
      }),
    );
    it.effect.each([
      '{"openapi":"3.1.0","openapi":"3.0.3","paths":{}}',
      "openapi: 3.1.0\nopenapi: 3.0.3\npaths: {}",
      "---\nopenapi: 3.1.0\n---\nopenapi: 3.0.3",
      "openapi: !custom 3.1.0\npaths: {}",
      "openapi: 3.1.0\npaths: &recursive { /x: *recursive }",
    ])("rejects ambiguous YAML/JSON input safely (%s)", (contents) =>
      Effect.gen(function* () {
        const file = yield* documentFile(contents);
        const failure = yield* Effect.flip(loadOperationCatalog(file));
        expect(failure.message).toBe("Invalid OpenAPI JSON/YAML document.");
      }),
    );
  },
);
