import { InvalidArguments } from "./api-errors.ts";
import type { JsonValue } from "./openapi-types.ts";
import {
  isBracketSegment,
  isBracketKey,
  MAX_BRACKET_BYTES,
  MAX_BRACKET_DEPTH,
  MAX_BRACKET_PAIRS,
} from "./parameter-profile.ts";
export {
  MAX_BRACKET_BYTES,
  MAX_BRACKET_DEPTH,
  MAX_BRACKET_PAIRS,
} from "./parameter-profile.ts";

export type QueryEncoding =
  | Readonly<{
      style: "form" | "deepObject" | "spaceDelimited" | "pipeDelimited";
      explode: boolean;
      profile?: never;
    }>
  | Readonly<{
      style: "deepObject";
      explode: boolean;
      profile: "brackets-indexed";
    }>;

const MAX_BRACKET_NODES = MAX_BRACKET_PAIRS * (MAX_BRACKET_DEPTH + 1) + 1;

type VisitFrame = Readonly<{
  mode: "visit";
  name: string;
  value: unknown;
  depth: number;
}>;
type ChildrenFrame = {
  mode: "children";
  name: string;
  value: object;
  depth: number;
  children: ReadonlyArray<readonly [string, unknown]>;
  index: number;
};
// RFC 6570 separators must remain distinct from separators present in values.
export const encodeParameter = (value: string): string =>
  encodeURIComponent(wellFormed(value)).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export const formEncode = (value: string): string =>
  new URLSearchParams([["", wellFormed(value)]]).toString().slice(1);
const invalid = (message: string): never => {
  throw new InvalidArguments({ message });
};
const wellFormed = (value: string): string =>
  value.isWellFormed()
    ? value
    : invalid("HTTP parameter text must be well-formed Unicode.");
const scalar = (value: JsonValue): string =>
  value !== null && typeof value !== "object"
    ? String(value)
    : invalid("HTTP style values must be non-null scalars.");

const bracketChildren = (
  value: object,
): ReadonlyArray<readonly [string, unknown]> => {
  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
      (array ? Array.prototype : Object.prototype) &&
    !(Object.getPrototypeOf(value) === null && !array)
  )
    return invalid(
      "Indexed bracket values must use plain JSON objects and arrays.",
    );
  if (array && value.length > MAX_BRACKET_PAIRS)
    return invalid(
      "Indexed bracket serialization exceeds the maximum pair count.",
    );
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_BRACKET_PAIRS + (array ? 1 : 0))
    return invalid(
      "Indexed bracket serialization exceeds the maximum pair count.",
    );
  const children: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string")
      return invalid("Indexed bracket values must have JSON property names.");
    if (
      array
        ? !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length
        : !isBracketKey(key)
    )
      return invalid(
        "Indexed bracket object keys must be safe, nonempty segments without brackets.",
      );
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return invalid(
        "Indexed bracket values must have enumerable JSON data properties.",
      );
    // Each untyped descriptor value crosses the JSON boundary once in the iterative visit loop.
    const item: unknown = descriptor.value;
    children.push([key, item]);
  }
  if (array && children.length !== value.length)
    return invalid(
      "Indexed bracket serialization does not support sparse arrays.",
    );
  return children;
};

const encodeBrackets = (
  name: string,
  value: JsonValue,
  encode: (text: string) => string,
): ReadonlyArray<readonly [string, string]> => {
  if (!isBracketSegment(name))
    return invalid(
      "Indexed bracket parameter names must be safe, nonempty, nonnumeric segments without brackets.",
    );
  const output: Array<readonly [string, string]> = [];
  const stack: Array<VisitFrame | ChildrenFrame> = [
    { mode: "visit", name, value, depth: 0 },
  ];
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (frame.mode === "children") {
      const child = frame.children[frame.index++];
      if (child === undefined) {
        ancestors.delete(frame.value);
        continue;
      }
      if (
        frame.depth >= MAX_BRACKET_DEPTH ||
        stack.length + 2 > MAX_BRACKET_DEPTH + 2
      )
        return invalid(
          "Indexed bracket serialization exceeds the maximum traversal depth.",
        );
      stack.push(frame, {
        mode: "visit",
        name: `${frame.name}[${child[0]}]`,
        value: child[1],
        depth: frame.depth + 1,
      });
      continue;
    }
    if (++nodes > MAX_BRACKET_NODES)
      return invalid(
        "Indexed bracket serialization exceeds the maximum visited node count.",
      );
    if (frame.depth > MAX_BRACKET_DEPTH)
      return invalid(
        "Indexed bracket serialization exceeds the maximum traversal depth.",
      );
    if (frame.name.length > MAX_BRACKET_BYTES)
      return invalid(
        "Indexed bracket serialization exceeds the maximum encoded byte count.",
      );
    if (frame.value === null)
      return invalid(
        "Indexed bracket serialization does not support null values.",
      );
    if (typeof frame.value === "object") {
      if (ancestors.has(frame.value))
        return invalid(
          "Indexed bracket serialization does not support cyclic values.",
        );
      const children = bracketChildren(frame.value);
      ancestors.add(frame.value);
      stack.push({
        mode: "children",
        name: frame.name,
        value: frame.value,
        depth: frame.depth,
        children,
        index: 0,
      });
      continue;
    }
    if (
      typeof frame.value !== "string" &&
      typeof frame.value !== "boolean" &&
      typeof frame.value !== "number"
    )
      return invalid("Indexed bracket values must contain only JSON data.");
    if (typeof frame.value === "number" && !Number.isFinite(frame.value))
      return invalid("Indexed bracket serialization requires finite numbers.");
    if (output.length >= MAX_BRACKET_PAIRS)
      return invalid(
        "Indexed bracket serialization exceeds the maximum pair count.",
      );
    const text = String(frame.value);
    if (text.length > MAX_BRACKET_BYTES)
      return invalid(
        "Indexed bracket serialization exceeds the maximum encoded byte count.",
      );
    const encodedName = encode(wellFormed(frame.name));
    const encodedValue = encode(wellFormed(text));
    bytes +=
      Buffer.byteLength(encodedName) +
      1 +
      Buffer.byteLength(encodedValue) +
      (output.length === 0 ? 0 : 1);
    if (bytes > MAX_BRACKET_BYTES)
      return invalid(
        "Indexed bracket serialization exceeds the maximum encoded byte count.",
      );
    output.push([frame.name, encodedValue]);
  }
  return output;
};

export const encodeStyled = (
  name: string,
  value: JsonValue,
  encoding: QueryEncoding,
  encode: (value: string) => string = encodeParameter,
): ReadonlyArray<readonly [string, string]> => {
  if (encoding.profile === "brackets-indexed")
    return encodeBrackets(name, value, encode);
  const { style, explode } = encoding;
  if (style === "deepObject") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalid("deepObject requires a flat object.");
    }
    if (
      name.includes("[") ||
      name.includes("]") ||
      Object.keys(value).some((key) => key.includes("[") || key.includes("]"))
    ) {
      return invalid(
        "deepObject names and keys must not contain bracket delimiters.",
      );
    }
    return Object.entries(value).map(([key, item]) => [
      `${name}[${key}]`,
      encode(scalar(item)),
    ]);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const delimiter =
      style === "spaceDelimited"
        ? " "
        : style === "pipeDelimited"
          ? "|"
          : undefined;
    if (
      delimiter !== undefined &&
      value.some((item) => scalar(item).includes(delimiter))
    ) {
      return invalid(
        "Delimited array items must not contain their separator character.",
      );
    }
    const values = value.map((item) => encode(scalar(item)));
    if (explode) {
      return values.map((item) => [name, item]);
    }
    const separator =
      style === "spaceDelimited"
        ? "%20"
        : style === "pipeDelimited"
          ? "%7C"
          : ",";
    return [[name, values.join(separator)]];
  }
  if (value !== null && typeof value === "object") {
    if (style !== "form") {
      return invalid("Delimited styles require an array.");
    }
    const values = Object.entries(value).map(
      ([key, item]) => [key, encode(scalar(item))] as const,
    );
    if (values.length === 0) return [];
    return explode
      ? values
      : [
          [
            name,
            values.flatMap(([key, item]) => [encode(key), item]).join(","),
          ],
        ];
  }
  if (style !== "form") {
    return invalid("This query style does not support scalar values.");
  }
  return [[name, encode(scalar(value))]];
};
