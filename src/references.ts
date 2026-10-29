import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect, Equal } from "effect";
import {
  HTTP_METHODS,
  isIgnoredHeaderParameter,
  type HttpMethod,
  type JsonObject,
  type JsonValue,
} from "./openapi-types.ts";
import {
  selectRequestMediaType,
  selectResponseMediaTypes,
} from "./media-type.ts";

export type ReferenceOptions = Readonly<{
  mode: "none" | "local" | "same-origin";
  maxDocuments: number;
  maxDepth: number;
  methods?: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
}>;

export class ReferenceError extends Data.TaggedError("ReferenceError")<
  Readonly<{
    reason:
      | "configuration"
      | "pointer"
      | "missing"
      | "policy"
      | "cycle"
      | "depth"
      | "documents"
      | "scope"
      | "version"
      | "collision"
      | "target";
    message: string;
  }>
> {}

const failure = (reason: ReferenceError["reason"], message: string) =>
  new ReferenceError({ reason, message });
const record = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: JsonObject, key: string): JsonValue | undefined =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const pointerToken = (value: string) =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");
const pointer = (tokens: ReadonlyArray<string>) =>
  tokens.length === 0 ? "" : `/${tokens.map(pointerToken).join("/")}`;
const componentReference = (name: string) =>
  `#/components/schemas/${encodeURIComponent(pointerToken(name))}`;
const SCOPE_KEYS = [
  "$id",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
];
const hasScope = (value: JsonValue) =>
  record(value) && SCOPE_KEYS.some((key) => Object.hasOwn(value, key));
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const SCHEMA_ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_SINGLE = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "not",
  "contains",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
]);

type Kind =
  | "pathItem"
  | "operation"
  | "parameter"
  | "requestBody"
  | "response"
  | "emptyResponse"
  | "securityScheme"
  | "requestMedia"
  | "responseMedia";
type Document = Readonly<{
  value: JsonValue;
  retrieval: URL;
  base: URL;
  version: string;
  dialect: string | undefined;
}>;
type Target = Readonly<{
  document: Document;
  tokens: ReadonlyArray<string>;
  value: JsonValue;
  key: string;
}>;

const resolvePointer = (
  document: Document,
  hash: string,
  schema: boolean,
): Omit<Target, "key"> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(hash.slice(1));
  } catch {
    throw failure(
      "pointer",
      "The reference contains a malformed URI fragment.",
    );
  }
  if (decoded !== "" && !decoded.startsWith("/"))
    throw failure(
      "scope",
      "Named schema anchors are not supported; use a JSON Pointer reference.",
    );
  const tokens =
    decoded === ""
      ? []
      : decoded
          .slice(1)
          .split("/")
          .map((token) => {
            if (/~(?![01])/u.test(token))
              throw failure(
                "pointer",
                "The reference contains a malformed JSON Pointer escape.",
              );
            return token.replaceAll("~1", "/").replaceAll("~0", "~");
          });
  let value = document.value;
  let inheritedDialect: string | undefined;
  for (const token of tokens) {
    // Crossing a schema resource boundary without honoring its URI would change reference meaning.
    if (schema && hasScope(value))
      throw failure(
        "scope",
        "Schema identifiers, anchors and dynamic reference scopes are not supported.",
      );
    // A deep pointer still belongs to its enclosing schema resource's dialect.
    // OpenAPI root metadata is not itself a schema resource.
    const explicitDialect = record(value) ? own(value, "$schema") : undefined;
    if (
      schema &&
      record(value) &&
      typeof explicitDialect === "string" &&
      !(value === document.value && typeof own(value, "openapi") === "string")
    )
      inheritedDialect = explicitDialect;
    if (Array.isArray(value)) {
      if (
        !/^(0|[1-9]\d*)$/u.test(token) ||
        !Number.isSafeInteger(Number(token)) ||
        !Object.hasOwn(value, token)
      )
        throw failure(
          "pointer",
          "The reference contains an invalid or missing array index.",
        );
      const item = value[Number(token)];
      if (item === undefined)
        throw failure("missing", "The reference target does not exist.");
      value = item;
    } else if (record(value) && Object.hasOwn(value, token)) {
      const item = value[token];
      if (item === undefined)
        throw failure("missing", "The reference target does not exist.");
      value = item;
    } else {
      throw failure("missing", "The reference target does not exist.");
    }
  }
  if (schema && inheritedDialect !== undefined) {
    if (record(value) && !Object.hasOwn(value, "$schema"))
      value = { ...value, $schema: inheritedDialect };
    else if (typeof value === "boolean")
      value = { $schema: inheritedDialect, ...(value ? {} : { not: {} }) };
  }
  return { document, tokens, value };
};

const safeUri = (value: string, base: URL): URL => {
  // oxlint-disable-next-line no-control-regex -- URI references must not undergo browser-style whitespace/backslash normalization.
  if (/[\\\s\u0000-\u001f]/u.test(value) || /%(?![\da-f]{2})/iu.test(value))
    throw failure("pointer", "The reference is not a valid URI reference.");
  try {
    return new URL(value, base);
  } catch {
    throw failure("pointer", "The reference is not a valid URI reference.");
  }
};

const assertExternalPolicy = (
  source: URL,
  entry: URL,
  mode: ReferenceOptions["mode"],
) => {
  if (source.username !== "" || source.password !== "" || source.search !== "")
    throw failure(
      "policy",
      "Reference document URLs must not contain credentials or query parameters.",
    );
  if (mode === "local") {
    if (
      source.protocol !== "file:" ||
      entry.protocol !== "file:" ||
      source.host !== entry.host
    )
      throw failure(
        "policy",
        "Local references must stay within the entry document directory.",
      );
    let path: string;
    try {
      path = relative(dirname(fileURLToPath(entry)), fileURLToPath(source));
    } catch {
      throw failure(
        "policy",
        "Local reference file URLs must be valid filesystem paths.",
      );
    }
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw failure(
        "policy",
        "Local references must stay within the entry document directory.",
      );
    return;
  }
  const loopback =
    source.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(source.hostname);
  if (
    mode !== "same-origin" ||
    source.origin !== entry.origin ||
    (source.protocol !== "https:" && !loopback)
  )
    throw failure(
      "policy",
      "Remote references require HTTPS or loopback HTTP on the entry document origin.",
    );
};

/** Bundle only the API objects and request schemas used by callable operations.
 * The injected loader owns I/O budgets, deadlines, redirects and canonical file confinement.
 * The graph owns reference semantics, document/depth limits and lexical source policy.
 */
export const bundleOpenApi = <E, R>(
  entry: JsonValue,
  retrievalUri: URL,
  loadDocument: (source: URL) => Effect.Effect<JsonValue, E, R>,
  options: ReferenceOptions,
): Effect.Effect<JsonValue, E | ReferenceError, R> =>
  Effect.suspend(() => {
    // This state belongs to one evaluation, including when the returned Effect is reused concurrently.
    const documents = new Map<string, Document>();
    const schemas = new Map<string, string>();
    const processedSchemas = new Map<string, JsonValue>();
    const schemaDepths = new Map<string, number>();
    const activeSchemas: Array<{
      key: string;
      parentDepth: number;
      height: number;
      cyclic: boolean;
    }> = [];
    const securitySchemes = new Map<string, JsonValue>();
    let documentCount = 0;
    const entryVersion =
      record(entry) && typeof entry.openapi === "string"
        ? entry.openapi
        : "3.1.0";
    const rootComponents =
      record(entry) && record(entry.components) ? entry.components : {};
    const rootSchemas = record(rootComponents.schemas)
      ? rootComponents.schemas
      : {};
    const rootSecurity = record(rootComponents.securitySchemes)
      ? rootComponents.securitySchemes
      : {};

    const checked = <A>(evaluate: () => A): Effect.Effect<A, ReferenceError> =>
      Effect.try({
        try: evaluate,
        catch: (error) => {
          if (error instanceof ReferenceError) return error;
          throw error;
        },
      });
    const register = (value: JsonValue, retrieval: URL): Document => {
      const version =
        record(value) && typeof value.openapi === "string"
          ? value.openapi
          : entryVersion;
      if (
        version.split(".").slice(0, 2).join(".") !==
        entryVersion.split(".").slice(0, 2).join(".")
      )
        throw failure(
          "version",
          "Referenced OpenAPI documents must use the entry document's major and minor version.",
        );
      const base =
        record(value) &&
        typeof value.openapi === "string" &&
        value.openapi.startsWith("3.2.") &&
        Object.hasOwn(value, "$self")
          ? typeof value.$self === "string"
            ? safeUri(value.$self, retrieval)
            : (() => {
                throw failure(
                  "scope",
                  "The document identifier must be a URI reference.",
                );
              })()
          : new URL(retrieval);
      if (
        base.hash !== "" ||
        base.search !== "" ||
        base.username !== "" ||
        base.password !== ""
      )
        throw failure(
          "scope",
          "Document identifiers must not contain fragments, queries or credentials.",
        );
      const document: Document = {
        value,
        retrieval: new URL(retrieval),
        base,
        version,
        dialect:
          record(value) &&
          typeof value.openapi === "string" &&
          !version.startsWith("3.0.") &&
          typeof value.jsonSchemaDialect === "string"
            ? value.jsonSchemaDialect
            : undefined,
      };
      for (const alias of new Set([retrieval.href, base.href])) {
        const existing = documents.get(alias);
        if (existing !== undefined && existing.value !== value)
          throw failure(
            "collision",
            "Two reference documents claim the same identifier.",
          );
        documents.set(alias, document);
      }
      documentCount++;
      return document;
    };
    let root: Document;

    const target = (
      reference: string,
      context: Document,
      schema: boolean,
      depth: number,
    ): Effect.Effect<Target | undefined, E | ReferenceError, R> =>
      Effect.gen(function* () {
        const uri = yield* checked(() => safeUri(reference, context.base));
        if (uri.username !== "" || uri.password !== "" || uri.search !== "")
          return yield* failure(
            "policy",
            "Reference document URLs must not contain credentials or query parameters.",
          );
        const hash = uri.hash;
        uri.hash = "";
        let document = documents.get(uri.href);
        if (document === undefined) {
          if (options.mode === "none") return undefined;
          yield* assertDepth(depth + 1);
          yield* checked(() =>
            assertExternalPolicy(uri, retrievalUri, options.mode),
          );
          if (documentCount >= options.maxDocuments)
            return yield* failure(
              "documents",
              "Reference loading exceeds the configured maximum document count.",
            );
          const loaded = yield* loadDocument(new URL(uri));
          document = yield* checked(() => register(loaded, uri));
        }
        const resolved = yield* checked(() =>
          resolvePointer(document, hash, schema),
        );
        return {
          ...resolved,
          key: `${document.retrieval.href}#${pointer(resolved.tokens)}`,
        };
      });
    const assertDepth = (depth: number) =>
      depth > options.maxDepth
        ? Effect.fail(
            failure(
              "depth",
              "Reference traversal exceeds the configured maximum depth.",
            ),
          )
        : Effect.void;

    const visitSchema = (
      value: JsonValue,
      context: Document,
      depth: number,
      applyDialect = true,
    ): Effect.Effect<JsonValue, E | ReferenceError, R> =>
      Effect.gen(function* () {
        yield* assertDepth(depth);
        if (typeof value === "boolean")
          return context !== root &&
            applyDialect &&
            context.dialect !== undefined
            ? { $schema: context.dialect, ...(value ? {} : { not: {} }) }
            : value;
        if (!record(value))
          return yield* failure(
            "target",
            "A schema reference must identify an object or boolean schema.",
          );
        if (
          hasScope(value) &&
          !(
            context.version.startsWith("3.0.") && typeof value.$ref === "string"
          )
        )
          return yield* failure(
            "scope",
            "Schema identifiers, anchors and dynamic reference scopes are not supported.",
          );
        let output: JsonObject = { ...value };
        if (
          context !== root &&
          applyDialect &&
          context.dialect !== undefined &&
          output.$schema === undefined
        )
          output.$schema = context.dialect;
        if (Object.hasOwn(value, "$ref")) {
          if (typeof value.$ref !== "string")
            return yield* failure(
              "target",
              "A schema reference must be a URI string.",
            );
          const resolved = yield* target(value.$ref, context, true, depth);
          if (resolved !== undefined) {
            let name = schemas.get(resolved.key);
            if (name === undefined) {
              const directRoot =
                resolved.document === root &&
                resolved.tokens.length === 3 &&
                resolved.tokens[0] === "components" &&
                resolved.tokens[1] === "schemas";
              name = directRoot ? resolved.tokens[2] : undefined;
              if (name === undefined) {
                name = `mcp_ref_${createHash("sha256").update(resolved.key).digest("hex")}`;
                if (Object.hasOwn(rootSchemas, name))
                  return yield* failure(
                    "collision",
                    "A generated schema definition conflicts with an existing component.",
                  );
              }
              // Reserve before descending so recursive schemas remain finite references.
              schemas.set(resolved.key, name);
            }
            if (activeSchemas.some((frame) => frame.key === resolved.key)) {
              // Backedges remain references, rather than imposing an infinite depth on recursive schemas.
              for (const frame of activeSchemas) frame.cyclic = true;
            } else {
              const knownHeight = schemaDepths.get(resolved.key);
              let height: number;
              if (knownHeight !== undefined) {
                yield* assertDepth(depth + knownHeight);
                height = knownHeight;
              } else {
                yield* assertDepth(depth + 1);
                const frame = {
                  key: resolved.key,
                  parentDepth: depth,
                  height: 1,
                  cyclic: false,
                };
                activeSchemas.push(frame);
                const processed = yield* visitSchema(
                  resolved.value,
                  resolved.document,
                  depth + 1,
                ).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      activeSchemas.pop();
                    }),
                  ),
                );
                processedSchemas.set(name, processed);
                height = frame.height;
                // Cyclic subtree heights depend on ancestry, so only acyclic summaries can be reused.
                if (!frame.cyclic) schemaDepths.set(resolved.key, height);
              }
              for (const frame of activeSchemas)
                frame.height = Math.max(
                  frame.height,
                  depth - frame.parentDepth + height,
                );
            }
            output = context.version.startsWith("3.0.") ? {} : output;
            output.$ref =
              context === root &&
              resolved.document === root &&
              value.$ref.startsWith("#/components/schemas/") &&
              resolved.tokens.length === 3 &&
              resolved.tokens[0] === "components" &&
              resolved.tokens[1] === "schemas"
                ? value.$ref
                : componentReference(name);
          } else if (context.version.startsWith("3.0.")) {
            output = { $ref: value.$ref };
          }
        }
        for (const [key, child] of Object.entries(output)) {
          if (key === "$defs") {
            // Referenced definitions are lifted on demand; unused definitions do not affect validation.
            if (
              !record(child) ||
              Object.values(child).some(
                (member) => typeof member !== "boolean" && !record(member),
              )
            )
              return yield* failure(
                "target",
                "Embedded schema definitions must be an object map.",
              );
            delete output[key];
          } else if (SCHEMA_MAPS.has(key)) {
            if (!record(child))
              return yield* failure(
                "target",
                "A schema map must contain schema objects.",
              );
            const members: [string, JsonValue][] = [];
            for (const [name, member] of Object.entries(child))
              members.push([
                name,
                yield* visitSchema(member, context, depth, false),
              ]);
            output[key] = Object.fromEntries(members);
          } else if (SCHEMA_ARRAYS.has(key)) {
            if (!Array.isArray(child))
              return yield* failure(
                "target",
                "A schema composition must contain an array of schemas.",
              );
            output[key] = yield* Effect.forEach(child, (member) =>
              visitSchema(member, context, depth, false),
            );
          } else if (SCHEMA_SINGLE.has(key)) {
            output[key] = yield* visitSchema(child, context, depth, false);
          }
        }
        return output;
      });

    const rebaseServers = (
      value: JsonValue,
      context: Document,
    ): Effect.Effect<JsonValue, ReferenceError> =>
      checked(() => {
        if (!Array.isArray(value) || context.retrieval.protocol === "file:")
          return value;
        return value.map((server) => {
          if (!record(server) || typeof server.url !== "string") return server;
          // Absolute server URLs need no rebasing. Let the compiler validate
          // the selected server per operation, or honor an explicit override.
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(server.url)) return server;
          const url = server.url.replace(
            /\{([^{}]+)\}/gu,
            (_match, name: string) => {
              const variable = record(server.variables)
                ? own(server.variables, name)
                : undefined;
              if (!record(variable) || typeof variable.default !== "string")
                throw failure(
                  "target",
                  "A referenced server variable has no string default.",
                );
              return variable.default;
            },
          );
          if (URL.canParse(url)) return server;
          try {
            return {
              ...server,
              url: new URL(url, context.retrieval).href,
              variables: {},
            };
          } catch {
            throw failure("target", "A referenced API server URL is invalid.");
          }
        });
      });

    const visitSecurity = (
      requirements: JsonValue,
      context: Document,
      depth: number,
    ): Effect.Effect<JsonValue, E | ReferenceError, R> =>
      Effect.gen(function* () {
        if (!Array.isArray(requirements)) return requirements;
        for (const requirement of requirements) {
          if (!record(requirement)) continue;
          for (const name of Object.keys(requirement)) {
            const components =
              record(context.value) && record(context.value.components)
                ? context.value.components
                : {};
            const declared = record(components.securitySchemes)
              ? own(components.securitySchemes, name)
              : undefined;
            const scheme =
              declared ??
              (context.version.startsWith("3.2.") ? { $ref: name } : undefined);
            if (scheme === undefined) continue;
            const expanded = yield* visitObject(
              scheme,
              "securityScheme",
              context,
              depth,
              new Set(),
            );
            const previous = securitySchemes.get(name);
            const existingRoot = own(rootSecurity, name);
            const resolvedRoot =
              context !== root && existingRoot !== undefined
                ? yield* visitObject(
                    existingRoot,
                    "securityScheme",
                    root,
                    depth,
                    new Set(),
                  )
                : undefined;
            if (
              (previous !== undefined && !Equal.equals(previous, expanded)) ||
              (resolvedRoot !== undefined &&
                !Equal.equals(resolvedRoot, expanded))
            )
              return yield* failure(
                "collision",
                "Referenced documents declare conflicting security schemes with the same name.",
              );
            securitySchemes.set(name, expanded);
          }
        }
        return requirements;
      });

    const visitObject = (
      value: JsonValue,
      kind: Kind,
      context: Document,
      depth: number,
      ancestors: ReadonlySet<string>,
      operationMethod?: HttpMethod,
    ): Effect.Effect<JsonObject, E | ReferenceError, R> =>
      Effect.gen(function* () {
        yield* assertDepth(depth);
        if (!record(value))
          return yield* failure(
            "target",
            "An API object reference must identify an object.",
          );
        if (Object.hasOwn(value, "$ref")) {
          if (typeof value.$ref !== "string")
            return yield* failure(
              "target",
              "An API object reference must be a URI string.",
            );
          const resolved = yield* target(value.$ref, context, false, depth);
          if (resolved === undefined) return { ...value };
          const key = `${kind}:${resolved.key}`;
          if (ancestors.has(key))
            return yield* failure(
              "cycle",
              "Cyclic API object references cannot be expanded.",
            );
          const expanded = yield* visitObject(
            resolved.value,
            kind,
            resolved.document,
            depth + 1,
            new Set(ancestors).add(key),
            operationMethod,
          );
          if (kind === "pathItem") {
            const siblings = Object.fromEntries(
              Object.entries(value).filter(([key]) => key !== "$ref"),
            );
            if (
              Object.keys(siblings).some((key) => Object.hasOwn(expanded, key))
            )
              return yield* failure(
                "collision",
                "A referenced Path Item and its siblings define the same field; OpenAPI leaves this behavior undefined.",
              );
            return {
              ...expanded,
              ...(yield* visitObject(
                siblings,
                kind,
                context,
                depth,
                ancestors,
              )),
            };
          }
          if (context.version.startsWith("3.0.")) return { ...expanded };
          const overrides: JsonObject = {};
          if (
            !["requestMedia", "responseMedia"].includes(kind) &&
            typeof value.description === "string"
          )
            overrides.description = value.description;
          if (
            (kind === "operation" ||
              ((kind === "response" || kind === "emptyResponse") &&
                context.version.startsWith("3.2."))) &&
            typeof value.summary === "string"
          )
            overrides.summary = value.summary;
          return { ...expanded, ...overrides };
        }
        // Resolve the Parameter Object itself, but never load an ignored header's schema.
        if (kind === "parameter" && isIgnoredHeaderParameter(value))
          return { ...value };
        const output = { ...value };
        if (
          kind === "operation" &&
          (options.tags?.length ?? 0) > 0 &&
          (!Array.isArray(value.tags) ||
            !value.tags.some(
              (tag) => typeof tag === "string" && options.tags?.includes(tag),
            ))
        )
          return output;
        if (
          (kind === "pathItem" || kind === "operation") &&
          output.servers !== undefined
        )
          output.servers = yield* rebaseServers(output.servers, context);
        if (kind === "pathItem") {
          for (const method of HTTP_METHODS) {
            const operation = own(value, method);
            if (operation !== undefined)
              output[method] =
                (options.methods?.length ?? 0) > 0 &&
                !options.methods?.includes(method)
                  ? operation
                  : yield* visitObject(
                      operation,
                      "operation",
                      context,
                      depth,
                      ancestors,
                      method,
                    );
          }
          // Custom methods are diagnosed by the compiler; their dependencies cannot be callable here.
        }
        if (
          (kind === "operation" ||
            (kind === "pathItem" &&
              HTTP_METHODS.some((method) => {
                if (
                  (options.methods?.length ?? 0) > 0 &&
                  !options.methods?.includes(method)
                )
                  return false;
                const operation = own(output, method);
                return (
                  record(operation) &&
                  ((options.tags?.length ?? 0) === 0 ||
                    (Array.isArray(operation.tags) &&
                      operation.tags.some(
                        (tag) =>
                          typeof tag === "string" &&
                          options.tags?.includes(tag),
                      )))
                );
              }))) &&
          Array.isArray(value.parameters)
        )
          output.parameters = yield* Effect.forEach(
            value.parameters,
            (parameter) =>
              visitObject(parameter, "parameter", context, depth, ancestors),
          );
        if (kind === "operation") {
          if (value.requestBody !== undefined)
            output.requestBody = yield* visitObject(
              value.requestBody,
              "requestBody",
              context,
              depth,
              ancestors,
            );
          if (value.security !== undefined)
            output.security = yield* visitSecurity(
              value.security,
              context,
              depth,
            );
          else if (record(entry) && entry.security !== undefined)
            yield* visitSecurity(entry.security, root, depth);
          if (record(value.responses)) {
            const responses: [string, JsonValue][] = [];
            for (const [status, response] of Object.entries(value.responses))
              responses.push([
                status,
                /^2\d\d$|^2XX$|^default$/u.test(status)
                  ? yield* visitObject(
                      response,
                      operationMethod === "head" ||
                        status === "204" ||
                        status === "205"
                        ? "emptyResponse"
                        : "response",
                      context,
                      depth,
                      ancestors,
                    )
                  : response,
              ]);
            output.responses = Object.fromEntries(responses);
          }
        }
        if (
          (kind === "parameter" ||
            (kind === "requestMedia" && value.itemSchema === undefined)) &&
          value.schema !== undefined
        )
          output.schema = yield* visitSchema(value.schema, context, depth);
        if (
          ["parameter", "requestBody", "response"].includes(kind) &&
          record(value.content)
        ) {
          const content: [string, JsonValue][] = [];
          const selected =
            kind === "requestBody"
              ? [selectRequestMediaType(Object.keys(value.content))]
              : kind === "response"
                ? selectResponseMediaTypes(Object.keys(value.content))
                : [];
          for (const [mediaType, media] of Object.entries(value.content)) {
            const needed = selected.includes(mediaType);
            content.push([
              mediaType,
              needed
                ? yield* visitObject(
                    media,
                    kind === "response" ? "responseMedia" : "requestMedia",
                    context,
                    depth,
                    ancestors,
                  )
                : media,
            ]);
          }
          output.content = Object.fromEntries(content);
        }
        return output;
      });

    return Effect.gen(function* () {
      if (
        !["none", "local", "same-origin"].includes(options.mode) ||
        !Number.isSafeInteger(options.maxDocuments) ||
        options.maxDocuments < 1 ||
        !Number.isSafeInteger(options.maxDepth) ||
        options.maxDepth < 1
      )
        return yield* failure(
          "configuration",
          "Reference limits must be positive integers and the reference mode must be supported.",
        );
      root = yield* checked(() => register(entry, retrievalUri));
      if (!record(entry)) return entry;
      const output = { ...entry };
      if (entry.servers !== undefined)
        output.servers = yield* rebaseServers(entry.servers, root);
      if (record(entry.paths)) {
        const paths: [string, JsonValue][] = [];
        for (const [path, item] of Object.entries(entry.paths))
          paths.push([
            path,
            path.startsWith("/")
              ? yield* visitObject(item, "pathItem", root, 0, new Set())
              : item,
          ]);
        output.paths = Object.fromEntries(paths);
      }
      if (processedSchemas.size > 0 || securitySchemes.size > 0)
        output.components = {
          ...rootComponents,
          ...(processedSchemas.size === 0
            ? {}
            : {
                schemas: {
                  ...rootSchemas,
                  ...Object.fromEntries(processedSchemas),
                },
              }),
          ...(securitySchemes.size === 0
            ? {}
            : {
                securitySchemes: {
                  ...rootSecurity,
                  ...Object.fromEntries(securitySchemes),
                },
              }),
        };
      return output;
    });
  });
