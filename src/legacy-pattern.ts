// OpenAPI 3.0 references ECMA-262 Edition 5.1, where punctuation identity
// escapes denote literal characters. Hex escapes retain those literals in the
// Unicode-mode regexes used by the native schema importer.
const IDENTITY_PUNCTUATION = new Set([
  "!",
  '"',
  "#",
  "%",
  "&",
  "'",
  ",",
  "-",
  ":",
  ";",
  "<",
  "=",
  ">",
  "@",
  "`",
  "~",
]);

export const normalizeLegacyPattern = (pattern: string): string => {
  // Never repair malformed regex syntax as a side effect of normalization.
  new RegExp(pattern);
  let output = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern.charAt(index);
    if (character !== "\\") {
      output += character;
      continue;
    }
    // Consume an entire escape, preserving escaped backslashes and regex syntax.
    const escaped = pattern.charAt(++index);
    output += IDENTITY_PUNCTUATION.has(escaped)
      ? `\\x${escaped.charCodeAt(0).toString(16)}`
      : `\\${escaped}`;
  }
  return output;
};
