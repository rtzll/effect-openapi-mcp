import { Effect } from "effect";
import {
  DEFAULT_MAX_REFERENCE_DEPTH,
  DEFAULT_MAX_REFERENCE_DOCUMENTS,
  type ReferencesMode,
} from "./config.ts";
import { OpenApiError } from "./openapi-errors.ts";
import {
  analyzeOpenApi,
  compileOpenApi,
  type CompileOptions,
} from "./openapi.ts";
import { bundleOpenApi } from "./references.ts";
import { withSpecSource } from "./spec-source.ts";

export { parseOpenApi } from "./spec-source.ts";
// A loader derives sourceUrl from retrieval; API target overrides belong in baseUrl.
export type LoadOptions = Omit<CompileOptions, "sourceUrl"> &
  Readonly<{
    maxSpecBytes?: number;
    specTimeoutMs?: number;
    referencesMode?: ReferencesMode;
    maxReferenceDocuments?: number;
    maxReferenceDepth?: number;
  }>;

const compileDocument = (
  compile: typeof compileOpenApi,
  location: string,
  options: LoadOptions,
) =>
  withSpecSource(location, options, (source) =>
    Effect.gen(function* () {
      const document = yield* bundleOpenApi(
        source.entry,
        source.retrievalUri,
        source.loadDocument,
        {
          mode: options.referencesMode ?? "none",
          maxDocuments:
            options.maxReferenceDocuments ?? DEFAULT_MAX_REFERENCE_DOCUMENTS,
          maxDepth: options.maxReferenceDepth ?? DEFAULT_MAX_REFERENCE_DEPTH,
          methods: options.methods,
          tags: options.tags,
        },
      );
      return yield* Effect.try({
        try: () =>
          compile(document, {
            ...options,
            sourceUrl: source.sourceUrl,
          }),
        catch: (error) => {
          if (error instanceof OpenApiError) return error;
          throw error;
        },
      });
    }),
  );

export const loadOperationCatalog = Effect.fn("openapi.load")(function* (
  location: string,
  options: LoadOptions = {},
) {
  return yield* compileDocument(compileOpenApi, location, options);
});

export const inspectOperationCatalog = Effect.fn("openapi.inspect")(function* (
  location: string,
  options: LoadOptions = {},
) {
  return yield* compileDocument(analyzeOpenApi, location, options);
});
