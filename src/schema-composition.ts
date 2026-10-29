import type { JsonSchema, JsonObject, JsonValue } from "./openapi-types.ts";
import { componentName } from "./openapi-types.ts";
import { mapSchema, schemaNode } from "./schema-document.ts";

const ANNOTATIONS = new Set([
  "title",
  "description",
  "$comment",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
]);
const SCOPED = new Set([
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$schema",
  "$vocabulary",
  "unevaluatedProperties",
  "unevaluatedItems",
]);
const OBJECT_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
]);
export const MAX_COMPOSITION_BRANCHES = 256;
const MAX_CONJUNCTION_TERMS = 256;
const MAX_REFERENCE_DEPTH = 64;
const MAX_REFERENCE_EXPANSIONS = 256;
const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== undefined &&
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value);
const annotation = (key: string) =>
  ANNOTATIONS.has(key) || key.startsWith("x-");
const isScoped = (node: JsonObject) =>
  Object.keys(node).some((key) => SCOPED.has(key));
const annotations = (node: JsonObject): JsonObject =>
  Object.fromEntries(Object.entries(node).filter(([key]) => annotation(key)));
const mergeAnnotations = (...nodes: ReadonlyArray<JsonObject>): JsonObject => {
  const merged: JsonObject = {};
  for (const node of nodes) Object.assign(merged, annotations(node));
  if (nodes.some((node) => node.readOnly === true)) merged.readOnly = true;
  return merged;
};
const onlyReference = (
  node: JsonSchema,
): node is JsonObject & { $ref: string } =>
  typeof node !== "boolean" &&
  typeof node.$ref === "string" &&
  Object.keys(node).length === 1;

/** Normalize equivalent conjunctions before Effect lowers them into native schemas. */
export const makeCompositionNormalizer = (
  definitions: Readonly<Record<string, JsonObject>>,
) => {
  let branches = 0;
  let referenceExpansions = 0;
  const finiteReferences = new Map<string, boolean>();
  const finiteReference = (
    name: string,
    ancestors = new Set<string>(),
  ): boolean => {
    const known = finiteReferences.get(name);
    if (known !== undefined) return known;
    if (ancestors.has(name) || ancestors.size >= MAX_REFERENCE_DEPTH)
      return false;
    const target = Object.hasOwn(definitions, name)
      ? definitions[name]
      : undefined;
    if (target === undefined) return false;
    const references = new Set<string>();
    mapSchema(target, (node) => {
      if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/"))
        references.add(
          componentName(
            node.$ref.replace("#/$defs/", "#/components/schemas/"),
            "schemas",
          ),
        );
      return node;
    });
    const path = new Set(ancestors).add(name);
    const finite = [...references].every((reference) =>
      finiteReference(reference, path),
    );
    finiteReferences.set(name, finite);
    return finite;
  };
  const flatten = (input: ReadonlyArray<JsonSchema>): JsonSchema[] => {
    const output: JsonSchema[] = [];
    const references = new Set<string>();
    const visit = (node: JsonSchema, depth: number): void => {
      if (depth > MAX_REFERENCE_DEPTH || output.length >= MAX_CONJUNCTION_TERMS)
        throw new Error("Schema composition exceeds its conjunction limit.");
      if (
        typeof node !== "boolean" &&
        Array.isArray(node.allOf) &&
        Object.keys(node).every((key) => key === "allOf")
      ) {
        for (const child of node.allOf) visit(schemaNode(child), depth + 1);
      } else {
        if (onlyReference(node)) {
          if (references.has(node.$ref)) return;
          references.add(node.$ref);
        }
        output.push(node);
      }
    };
    for (const node of input) visit(node, 0);
    return output;
  };
  const openObject = (
    input: JsonSchema,
  ): { node: JsonObject; references: number } | undefined => {
    let node = input;
    const visited = new Set<string>();
    while (
      typeof node !== "boolean" &&
      typeof node.$ref === "string" &&
      Object.keys(node).every((key) => key === "$ref" || annotation(key))
    ) {
      if (
        !node.$ref.startsWith("#/$defs/") ||
        visited.has(node.$ref) ||
        visited.size >= MAX_REFERENCE_DEPTH
      )
        return undefined;
      visited.add(node.$ref);
      const key = componentName(
        node.$ref.replace("#/$defs/", "#/components/schemas/"),
        "schemas",
      );
      // Keep recursive definitions as references so native recursion handling stays bounded.
      if (!finiteReference(key)) return undefined;
      const target = Object.hasOwn(definitions, key)
        ? definitions[key]
        : undefined;
      if (target === undefined) return undefined;
      node = { ...target, ...mergeAnnotations(target, node) };
    }
    if (
      typeof node === "boolean" ||
      isScoped(node) ||
      (node.type !== undefined && node.type !== "object") ||
      (node.additionalProperties !== undefined &&
        node.additionalProperties !== true)
    )
      return undefined;
    if (
      !Object.keys(node).every((key) => OBJECT_KEYS.has(key) || annotation(key))
    )
      return undefined;
    if (
      node.type !== "object" &&
      node.properties === undefined &&
      node.required === undefined
    )
      return undefined;
    if (node.properties !== undefined && !isObject(node.properties))
      return undefined;
    return { node, references: visited.size };
  };
  const mergeOpenObjects = (terms: ReadonlyArray<JsonSchema>): JsonSchema[] => {
    // Closing and patterned object schemas retain their own keyword scopes.
    const candidates = terms.map(openObject);
    if (
      candidates.filter((node) => node !== undefined).length < 2 ||
      !candidates.some((candidate) => candidate?.node.type === "object")
    )
      return [...terms];
    referenceExpansions += candidates.reduce(
      (count, candidate) => count + (candidate?.references ?? 0),
      0,
    );
    if (referenceExpansions > MAX_REFERENCE_EXPANSIONS)
      throw new Error(
        "Schema composition exceeds its reference expansion limit.",
      );
    const properties = new Map<string, JsonSchema[]>();
    const required = new Set<string>();
    const merged: JsonObject = { type: "object" };
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      const { node } = candidate;
      Object.assign(merged, mergeAnnotations(merged, node));
      if (isObject(node.properties))
        for (const [name, child] of Object.entries(node.properties)) {
          const values = properties.get(name) ?? [];
          values.push(schemaNode(child));
          properties.set(name, values);
        }
      if (Array.isArray(node.required))
        for (const name of node.required)
          if (typeof name === "string") required.add(name);
    }
    merged.properties = Object.fromEntries(
      [...properties].map(([name, schemas]) => {
        const unique = flatten(schemas);
        return [name, unique.length === 1 ? unique[0]! : { allOf: unique }];
      }),
    );
    if (required.size > 0) merged.required = [...required];
    const output: JsonSchema[] = [];
    let inserted = false;
    for (let index = 0; index < terms.length; index++) {
      if (candidates[index] === undefined) output.push(terms[index]!);
      else if (!inserted) {
        output.push(merged);
        inserted = true;
      }
    }
    return output;
  };
  return (node: JsonObject): JsonObject => {
    if (isScoped(node)) return node;
    if (
      !Array.isArray(node.allOf) &&
      !Array.isArray(node.anyOf) &&
      !Array.isArray(node.oneOf)
    )
      return node;
    const { allOf, ...rest } = node;
    const terms = flatten([
      ...(Object.keys(rest).some((key) => !annotation(key)) ? [rest] : []),
      ...(Array.isArray(allOf) ? allOf.map(schemaNode) : []),
    ]);
    const merged = mergeOpenObjects(terms);
    for (let index = 0; index < merged.length; index++) {
      const term = merged[index];
      if (term === undefined || typeof term === "boolean" || isScoped(term))
        continue;
      const mode = Array.isArray(term.anyOf)
        ? "anyOf"
        : Array.isArray(term.oneOf)
          ? "oneOf"
          : undefined;
      if (mode === undefined) continue;
      const members = term[mode];
      if (!Array.isArray(members)) continue;
      const siblings = Object.fromEntries(
        Object.entries(term).filter(([key]) => key !== mode),
      );
      const other = merged.filter((_value, offset) => offset !== index);
      if (Object.keys(siblings).some((key) => !annotation(key)))
        other.push(siblings);
      if (other.length === 0) return node;
      branches += members.length;
      if (branches > MAX_COMPOSITION_BRANCHES)
        throw new Error(
          "Schema composition exceeds its branch expansion limit.",
        );
      // P AND union(A, B) = union(P AND A, P AND B), including oneOf exclusivity.
      // Leave nested operators nested; flattening mixed unions changes semantics.
      return {
        ...mergeAnnotations(node, term),
        [mode]: members.map((member) => ({
          allOf: [...other, schemaNode(member)],
        })),
      };
    }
    const first = merged[0];
    if (
      merged.length === 1 &&
      first !== undefined &&
      typeof first !== "boolean"
    )
      return { ...first, ...mergeAnnotations(first, node) };
    return { ...annotations(node), allOf: merged };
  };
};
