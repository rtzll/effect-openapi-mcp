import { Data } from "effect";

export class OpenApiError extends Data.TaggedError("OpenApiError")<
  Readonly<{ message: string }>
> {}

export type SpecLoadReason =
  | "missing"
  | "permission"
  | "read"
  | "size"
  | "utf8"
  | "httpStatus"
  | "network"
  | "timeout"
  | "url"
  | "syntax";

export class SpecLoadError extends Data.TaggedError("SpecLoadError")<
  Readonly<{ reason: SpecLoadReason; message: string }>
> {}

export class UnsupportedOperationError extends Error {}
