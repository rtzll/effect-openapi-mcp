import { Schema } from "effect";

export const PARAMETER_PROFILE_SCHEMA = Schema.Literals([
  "spec",
  "brackets-indexed",
]);
export type ParameterProfile = typeof PARAMETER_PROFILE_SCHEMA.Type;
export const DEFAULT_PARAMETER_PROFILE: ParameterProfile = "brackets-indexed";

// Applied per field and to the combined query/form wire output.
export const MAX_BRACKET_DEPTH = 64;
export const MAX_BRACKET_PAIRS = 4096;
export const MAX_BRACKET_BYTES = 8 * 1024 * 1024;

const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** A literal object-key segment, kept distinct from brackets and numeric array indexes. */
export const isBracketKey = (name: string): boolean =>
  name.length > 0 &&
  name.isWellFormed() &&
  !name.includes("[") &&
  !name.includes("]") &&
  !UNSAFE_SEGMENTS.has(name) &&
  !Object.hasOwn(Object.prototype, name);

export const isBracketSegment = (name: string): boolean =>
  isBracketKey(name) && !Number.isFinite(Number(name));

/** Names are still raw here; percent escapes are data, not another bracket delimiter. */
export const wireNamespace = (name: string): string => {
  const bracket = name.indexOf("[");
  return bracket === -1 ? name : name.slice(0, bracket);
};
