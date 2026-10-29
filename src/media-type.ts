export const isJsonMediaType = (value: string): boolean => {
  if (/[\r\n]/.test(value)) {
    return false;
  }
  const type = value.split(";", 1)[0]?.trim().toLowerCase();
  return (
    type === "application/json" ||
    /^application\/[^\s;]+\+json$/.test(type ?? "")
  );
};

// Ordinary text is one bounded UTF-8 representation, rather than a sequence of messages.
const utf8MediaEssence = (
  value: string,
  allowYaml: boolean,
): string | undefined => {
  if (/[^\x20-\x7E]/.test(value)) return undefined;
  const source = value.trim();
  const separator = source.indexOf(";");
  const essence = (separator === -1 ? source : source.slice(0, separator))
    .trim()
    .toLowerCase();
  const match = /^text\/([!#$%&'+.^_`|~0-9a-z-]+)$/.exec(essence);
  const subtype = match?.[1];
  if (
    !(allowYaml && essence === "application/yaml") &&
    (subtype === undefined ||
      /(?:^|[+.])(?:x-)?(?:event-stream|ndjson|json-seq|jsonl|jsonlines|json-lines)$/.test(
        subtype,
      ))
  )
    return undefined;
  const parameters =
    /;\s*([!#$%&'*+.^_`|~0-9a-z-]+)\s*=\s*(?:([!#$%&'*+.^_`|~0-9a-z-]+)|"((?:[^"\\]|\\.)*)")\s*/giy;
  const seen = new Set<string>();
  let offset = separator === -1 ? source.length : separator;
  while (offset < source.length) {
    parameters.lastIndex = offset;
    const parameter = parameters.exec(source);
    if (parameter === null) return undefined;
    const name = parameter[1]?.toLowerCase();
    if (name === undefined || seen.has(name)) return undefined;
    seen.add(name);
    const content = parameter[2] ?? parameter[3]?.replace(/\\(.)/g, "$1");
    if (
      name === "charset" &&
      !["utf-8", "utf8"].includes(content?.toLowerCase() ?? "")
    )
      return undefined;
    offset = parameters.lastIndex;
  }
  return essence;
};
export const textMediaEssence = (value: string): string | undefined =>
  utf8MediaEssence(value, false);
/** YAML responses use the same bounded UTF-8 reader and retain their source text. */
export const textResponseMediaEssence = (value: string): string | undefined =>
  utf8MediaEssence(value, true);
export const isTextMediaType = (value: string): boolean =>
  textMediaEssence(value) !== undefined;
export const isTextResponseMediaType = (value: string): boolean =>
  textResponseMediaEssence(value) !== undefined;

// Only finite opaque representations with an explicit supported media type.
// Sequential and multipart responses retain their own unsupported semantics.
export const binaryMediaEssence = (value: string): string | undefined => {
  if (/[^\x20-\x7E]/.test(value)) return undefined;
  const match = /^\s*(application\/(?:pdf|octet-stream))\s*$/i.exec(value);
  return match?.[1]?.toLowerCase();
};

export const selectRequestMediaType = (
  types: ReadonlyArray<string>,
): string | undefined =>
  types.find(isJsonMediaType) ??
  types.find((type) => type === "application/x-www-form-urlencoded") ??
  types.find(isTextMediaType) ??
  types.find((type) => type === "multipart/form-data");

export const selectResponseMediaTypes = (
  types: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const json = types.filter(isJsonMediaType);
  if (json.length > 0) return json;
  const text = types.filter(isTextResponseMediaType);
  return text.length > 0
    ? text
    : types.filter((type) => binaryMediaEssence(type) !== undefined);
};
