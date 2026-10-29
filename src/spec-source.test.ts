import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { Deferred, Effect, Fiber, FileSystem, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { expect, it } from "@effect/vitest";
import { withSpecSource } from "./spec-source.ts";

const graphFiles = Effect.fnUntraced(function* (
  entry: string,
  dependency: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "openapi-graph-",
  });
  const file = join(directory, "entry.yaml");
  yield* fs.writeFileString(file, entry);
  yield* fs.writeFileString(join(directory, "dependency.yaml"), dependency);
  return { directory, file };
});

it.layer(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer))(
  "OpenAPI source graph boundaries",
  (it) => {
    it.effect(
      "shares received UTF-8 bytes across root and dependencies, resetting each evaluation",
      () =>
        Effect.gen(function* () {
          const entry = '{"name":"é"}';
          const dependency = '{"type":"string"}';
          const files = yield* graphFiles(entry, dependency);
          const total =
            Buffer.byteLength(entry) + Buffer.byteLength(dependency);
          const load = (maxSpecBytes: number) =>
            withSpecSource(
              files.file,
              { referencesMode: "local", maxSpecBytes },
              (source) =>
                source.loadDocument(
                  new URL("./dependency.yaml", source.retrievalUri),
                ),
            );
          const exact = load(total);
          expect(yield* exact).toEqual({ type: "string" });
          expect(yield* exact).toEqual({ type: "string" });
          expect(
            yield* Effect.all([exact, exact], { concurrency: "unbounded" }),
          ).toEqual([{ type: "string" }, { type: "string" }]);
          expect(yield* Effect.flip(load(total - 1))).toHaveProperty(
            "reason",
            "size",
          );
        }),
    );
    it.effect(
      "resolves canonical local retrieval URIs without treating them as API server URLs",
      () =>
        Effect.gen(function* () {
          const files = yield* graphFiles("{}", "{}");
          const fs = yield* FileSystem.FileSystem;
          const canonical = yield* fs.realPath(files.file);
          const source = yield* withSpecSource(files.file, {}, (source) =>
            Effect.succeed({
              retrievalUri: source.retrievalUri.href,
              sourceUrl: source.sourceUrl,
            }),
          );
          expect(source).toEqual({
            retrievalUri: pathToFileURL(canonical).href,
            sourceUrl: undefined,
          });
        }),
    );
    it.effect(
      "rejects canonical symlink escapes before reading dependency bytes",
      () =>
        Effect.gen(function* () {
          const files = yield* graphFiles("{}", "{}");
          const fs = yield* FileSystem.FileSystem;
          const outside = yield* fs.makeTempDirectoryScoped({
            prefix: "outside-graph-",
          });
          const privateFile = join(outside, "private-secret.yaml");
          yield* fs.writeFileString(privateFile, '{"secret":"private-key"}');
          yield* fs.symlink(privateFile, join(files.directory, "link.yaml"));
          const reads: string[] = [];
          const failure = yield* Effect.flip(
            withSpecSource(files.file, { referencesMode: "local" }, (source) =>
              source.loadDocument(new URL("./link.yaml", source.retrievalUri)),
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                stream: (path, options) => {
                  reads.push(path);
                  return fs.stream(path, options);
                },
              }),
            ),
          );
          expect(failure).toHaveProperty("reason", "url");
          expect(reads).toEqual([yield* fs.realPath(files.file)]);
          expect(JSON.stringify(failure)).not.toContain("private-secret");
          expect(JSON.stringify(failure)).not.toContain("private-key");
        }),
    );
    it.effect(
      "rejects parent directory file dependencies before reading them",
      () =>
        Effect.gen(function* () {
          const files = yield* graphFiles("{}", "{}");
          const fs = yield* FileSystem.FileSystem;
          const parent = join(files.directory, "nested");
          yield* fs.makeDirectory(parent);
          const entry = join(parent, "entry.yaml");
          yield* fs.writeFileString(entry, "{}");
          const failure = yield* Effect.flip(
            withSpecSource(entry, { referencesMode: "local" }, (source) =>
              source.loadDocument(
                new URL("../dependency.yaml", source.retrievalUri),
              ),
            ),
          );
          expect(failure).toHaveProperty("reason", "url");
        }),
    );
    it.effect("keeps malformed dependency encoding errors typed", () =>
      Effect.gen(function* () {
        const files = yield* graphFiles("{}", "{}");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFile(
          join(files.directory, "dependency.yaml"),
          new Uint8Array([0xff]),
        );
        const failure = yield* Effect.flip(
          withSpecSource(files.file, { referencesMode: "local" }, (source) =>
            source.loadDocument(
              new URL("./dependency.yaml", source.retrievalUri),
            ),
          ),
        );
        expect(failure).toHaveProperty("reason", "utf8");
      }),
    );
    it.effect(
      "interprets native Windows absolute paths as files rather than URL schemes",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          let requested = "";
          const result = yield* withSpecSource(
            "C:\\specs\\api.yaml",
            {},
            (source) => Effect.succeed(source.entry),
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              realPath: (path) => {
                requested = path;
                return Effect.succeed("/canonical/spec.yaml");
              },
              stream: () => Stream.make(new TextEncoder().encode("{}")),
            }),
          );
          expect(requested).toBe("C:\\specs\\api.yaml");
          expect(result).toEqual({});
        }),
    );
    it.effect(
      "uses a single deadline across sequential root and dependency requests",
      () =>
        Effect.gen(function* () {
          const dependencyStarted = Deferred.makeUnsafe<void>();
          let dependencySignal: AbortSignal | undefined;
          const http = HttpClient.make((request, url, signal) =>
            Effect.gen(function* () {
              if (url.pathname === "/dependency.json") {
                dependencySignal = signal;
                yield* Deferred.succeed(dependencyStarted, undefined);
              }
              yield* Effect.sleep(6);
              return HttpClientResponse.fromWeb(request, new Response("{}"));
            }),
          );
          const load = yield* withSpecSource(
            "https://spec.example.com/entry.json",
            { referencesMode: "same-origin", specTimeoutMs: 10 },
            (source) =>
              source.loadDocument(
                new URL("./dependency.json", source.retrievalUri),
              ),
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.flip,
            Effect.forkChild,
          );
          yield* TestClock.adjust(6);
          yield* Deferred.await(dependencyStarted);
          yield* TestClock.adjust(4);
          expect(yield* Fiber.join(load)).toHaveProperty("reason", "timeout");
          expect(dependencySignal?.aborted).toBe(true);
        }),
    );
    it.effect(
      "suppresses ambient fetch credentials and redirects for every spec request",
      () =>
        Effect.gen(function* () {
          const requests: { path: string; init: RequestInit | undefined }[] =
            [];
          const fetch: typeof globalThis.fetch = (input, init) => {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
            requests.push({ path: new URL(url).pathname, init });
            return Promise.resolve(new Response("{}"));
          };
          const result = yield* withSpecSource(
            "https://spec.example.com/entry.json",
            { referencesMode: "same-origin" },
            (source) =>
              source.loadDocument(
                new URL("./dependency.json", source.retrievalUri),
              ),
          ).pipe(
            Effect.provideService(FetchHttpClient.Fetch, fetch),
            Effect.provideService(FetchHttpClient.RequestInit, {
              headers: { Authorization: "private-key" },
              credentials: "include",
              redirect: "follow",
            }),
          );
          expect(result).toEqual({});
          expect(requests.map((request) => request.path)).toEqual([
            "/entry.json",
            "/dependency.json",
          ]);
          for (const { init } of requests) {
            expect(init?.credentials).toBe("omit");
            expect(init?.redirect).toBe("error");
            expect(JSON.stringify(init?.headers)).not.toContain("private-key");
          }
        }),
    );
    it.effect.each([
      ["none", "https://spec.example.com/dependency.json"],
      ["local", "https://spec.example.com/dependency.json"],
      ["same-origin", "https://other.example.com/dependency.json"],
      ["same-origin", "https://private-key@spec.example.com/dependency.json"],
      [
        "same-origin",
        "https://spec.example.com/dependency.json?key=private-key",
      ],
      ["same-origin", "http://spec.example.com/dependency.json"],
      ["same-origin", "file:///private/secret.json"],
    ] as const)(
      "enforces remote dependency policy before dispatch (%s, %s)",
      ([referencesMode, dependency]) =>
        Effect.gen(function* () {
          let calls = 0;
          const http = HttpClient.make((request) => {
            calls++;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("{}")),
            );
          });
          const failure = yield* Effect.flip(
            withSpecSource(
              "https://spec.example.com/entry.json",
              { referencesMode },
              (source) => source.loadDocument(new URL(dependency)),
            ).pipe(Effect.provideService(HttpClient.HttpClient, http)),
          );
          expect(failure).toHaveProperty("reason", "url");
          expect(calls).toBe(1);
          expect(JSON.stringify(failure)).not.toContain("private-key");
          expect(JSON.stringify(failure)).not.toContain("secret.json");
        }),
    );
  },
);
