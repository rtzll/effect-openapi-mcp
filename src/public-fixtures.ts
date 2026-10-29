import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Schema } from "effect";
import { parseOpenApi } from "./catalog.ts";
import { OPENAPI_SCHEMA } from "./openapi-types.ts";

export const PUBLIC_SPECS = [
  "petstore-3.0.yaml",
  "github-3.0.json.gz",
  "github-3.1.json.gz",
  "oai-query-3.2.yaml",
  "oai-tags-3.2.yaml",
] as const;
export const readPublicSpec = (name: (typeof PUBLIC_SPECS)[number]) => {
  const stored = readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
  const contents = name.endsWith(".gz") ? gunzipSync(stored) : stored;
  const value = parseOpenApi(contents.toString());
  return {
    stored,
    contents,
    document: Schema.decodeUnknownSync(OPENAPI_SCHEMA)(value),
  };
};
