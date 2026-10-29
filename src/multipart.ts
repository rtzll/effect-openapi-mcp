import { randomBytes } from "node:crypto";
import { Result, Schema } from "effect";
import { InvalidArguments } from "./api-errors.ts";
import {
  compileFormBody,
  encodeFormBody,
  resolveFormObjectSchema,
  type FormBody,
} from "./form.ts";
import { UnsupportedOperationError } from "./openapi-errors.ts";
import {
  JSON_SCHEMA,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type MediaType,
} from "./openapi-types.ts";
import {
  isBracketSegment,
  MAX_BRACKET_PAIRS,
  wireNamespace,
  type ParameterProfile,
} from "./parameter-profile.ts";

const FILE_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$(?![\\s\\S])";
const MEDIA_TYPE_PATTERN =
  "^[A-Za-z0-9!#$%&'+.^_`|~-]+/[A-Za-z0-9!#$%&'+.^_`|~-]+$(?![\\s\\S])";
const BASE64_PATTERN = "^[A-Za-z0-9+/]*={0,2}$(?![\\s\\S])";
const FIELD_NAME = /^[\x20-\x21\x23-\x5B\x5D-\x7E]+$(?![\s\S])/;
const FILE_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["dataBase64", "filename", "mediaType"],
  properties: {
    dataBase64: { type: "string", pattern: BASE64_PATTERN },
    filename: { type: "string", pattern: FILE_NAME_PATTERN },
    mediaType: { type: "string", pattern: MEDIA_TYPE_PATTERN, maxLength: 255 },
  },
};
const FILE_INPUT = Schema.Struct({
  dataBase64: Schema.String,
  filename: Schema.String,
  mediaType: Schema.String,
});
const FILE_KEYS = new Set([
  "type",
  "format",
  "description",
  "title",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
  "externalDocs",
  "xml",
]);
export type MultipartBody = Readonly<{
  files: Readonly<Record<string, Readonly<{ mediaType?: string }>>>;
  form: FormBody;
  contentTypes: Readonly<Record<string, string>>;
}>;
const unsupported = (message: string): never => {
  throw new UnsupportedOperationError(message);
};
const invalid = (message: string): never => {
  throw new InvalidArguments({ message });
};
const schemaValue = (value: unknown): JsonSchema => {
  const decoded = Schema.decodeUnknownResult(JSON_SCHEMA)(value);
  return Result.isSuccess(decoded)
    ? decoded.success
    : unsupported("Invalid multipart field schema.");
};
const object = (value: JsonValue | undefined): value is JsonObject =>
  value !== undefined &&
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value);

export const compileMultipartBody = (
  media: MediaType,
  components: Readonly<Record<string, JsonSchema>>,
  version: string,
  profile: ParameterProfile,
): Readonly<{ schema: JsonObject; descriptor: MultipartBody }> => {
  const root = resolveFormObjectSchema(
    media.schema ?? true,
    components,
    version,
  );
  if (root.type !== "object" || !object(root.properties))
    return unsupported("Multipart bodies require explicit object properties.");
  if (root.additionalProperties !== false)
    return unsupported("Multipart bodies require additionalProperties: false.");
  const files = new Map<string, Readonly<{ mediaType?: string }>>();
  const properties = new Map<string, JsonValue>();
  const regular = new Map<string, JsonValue>();
  const contentTypes = new Map<string, string>();
  const regularEncoding = new Map<
    string,
    NonNullable<MediaType["encoding"]>[string]
  >();
  for (const [name, encoding] of Object.entries(media.encoding ?? {})) {
    if (!Object.hasOwn(root.properties, name))
      return unsupported(
        `Encoding refers to an undeclared multipart property: ${name}`,
      );
    if (
      encoding.headers !== undefined &&
      (!object(encoding.headers) || Object.keys(encoding.headers).length > 0)
    )
      return unsupported("Multipart part headers are not supported.");
  }
  for (const [name, raw] of Object.entries(root.properties)) {
    if (!FIELD_NAME.test(name))
      return unsupported(
        "Multipart field names must be printable ASCII without quotes or backslashes.",
      );
    const field = resolveFormObjectSchema(
      schemaValue(raw),
      components,
      version,
    );
    const encoding = Object.hasOwn(media.encoding ?? {}, name)
      ? (media.encoding?.[name] ?? {})
      : {};
    if (field.type === "string" && field.format === "binary") {
      if (!isBracketSegment(name))
        return unsupported(
          "Multipart file field names must be safe nonnumeric object keys.",
        );
      if (
        Object.keys(field).some(
          (key) => !FILE_KEYS.has(key) && !key.startsWith("x-"),
        )
      )
        return unsupported(
          "Constrained binary multipart fields are not supported.",
        );
      if (
        Object.keys(encoding).some(
          (key) => key !== "contentType" && key !== "headers",
        )
      )
        return unsupported(
          "Styled or nested binary multipart encoding is not supported.",
        );
      if (
        encoding.contentType !== undefined &&
        !new RegExp(MEDIA_TYPE_PATTERN).test(encoding.contentType)
      )
        return unsupported(
          "Multipart file contentType must be one concrete media type without parameters.",
        );
      files.set(
        name,
        encoding.contentType === undefined
          ? {}
          : { mediaType: encoding.contentType.toLowerCase() },
      );
      properties.set(name, {
        ...FILE_SCHEMA,
        ...(typeof field.description === "string"
          ? { description: field.description }
          : {}),
      });
    } else {
      const styled =
        encoding.style !== undefined ||
        encoding.explode !== undefined ||
        encoding.allowReserved !== undefined;
      if (styled && encoding.style !== "deepObject")
        return unsupported(
          "Multipart style encoding currently supports deepObject only.",
        );
      regular.set(name, raw);
      properties.set(name, raw);
      regularEncoding.set(name, encoding);
      if (!styled) {
        if (
          encoding.contentType !== undefined &&
          !new RegExp(MEDIA_TYPE_PATTERN).test(encoding.contentType)
        )
          return unsupported(
            "Multipart part contentType must be one concrete media type without parameters.",
          );
        const item =
          field.type === "array"
            ? resolveFormObjectSchema(
                schemaValue(field.items),
                components,
                version,
              )
            : field;
        contentTypes.set(
          name,
          encoding.contentType ??
            (item.type === "object" ? "application/json" : "text/plain"),
        );
      }
    }
  }
  const form = compileFormBody(
    {
      ...media,
      schema: { ...root, properties: Object.fromEntries(regular) },
      encoding: Object.fromEntries(regularEncoding),
    },
    components,
    version,
    profile,
  );
  return {
    schema: { ...root, properties: Object.fromEntries(properties) },
    descriptor: {
      files: Object.fromEntries(files),
      form,
      contentTypes: Object.fromEntries(contentTypes),
    },
  };
};

// Bound traversal before the form encoder creates escaped strings or JSON text.
const checkTextBudget = (value: JsonValue, maxBytes: number): void => {
  const pending = [value];
  let size = 0;
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (++nodes > MAX_BRACKET_PAIRS)
      invalid("Multipart text exceeds its traversal limit.");
    if (typeof item === "string") {
      if (!item.isWellFormed())
        invalid("Multipart text must be well-formed Unicode.");
      size += Buffer.byteLength(item);
    } else if (Array.isArray(item)) {
      if (item.length > MAX_BRACKET_PAIRS)
        invalid("Multipart text exceeds its traversal limit.");
      for (const child of item) pending.push(child);
    } else if (item !== null && typeof item === "object") {
      if (Object.keys(item).length > MAX_BRACKET_PAIRS)
        invalid("Multipart text exceeds its traversal limit.");
      for (const [name, child] of Object.entries(item)) {
        size += Buffer.byteLength(name);
        pending.push(child);
      }
    }
    if (size > maxBytes)
      invalid("The multipart request exceeds its byte limit.");
  }
};
type Part = Readonly<{
  name: string;
  data: Buffer;
  mediaType: string;
  filename?: string;
}>;
export const encodeMultipartBody = (
  body: JsonValue,
  descriptor: MultipartBody,
  maxBytes: number,
): Readonly<{ bytes: Uint8Array; contentType: string }> => {
  if (!object(body))
    return invalid("A multipart request body must be an object.");
  const parts: Part[] = [];
  const regular = new Map<string, JsonValue>();
  const fileNamespaces = new Set(
    Object.keys(descriptor.files).map(wireNamespace),
  );
  let bytes = 0;
  const append = (part: Part): void => {
    // Header parameters are quoted ASCII. Reject delimiters instead of changing API field names.
    if (!FIELD_NAME.test(part.name))
      invalid(
        "Multipart field names must be printable ASCII without quotes or backslashes.",
      );
    bytes += part.data.length;
    if (bytes > maxBytes || parts.length >= MAX_BRACKET_PAIRS)
      invalid("The multipart request exceeds its byte or part limit.");
    parts.push(part);
  };
  for (const [name, value] of Object.entries(body)) {
    if (!Object.hasOwn(descriptor.files, name)) {
      regular.set(name, value);
      continue;
    }
    const decoded = Schema.decodeUnknownResult(FILE_INPUT, {
      onExcessProperty: "error",
    })(value);
    if (Result.isFailure(decoded))
      return invalid(
        "Multipart files require dataBase64, filename and mediaType.",
      );
    const file = decoded.success;
    if (
      !new RegExp(FILE_NAME_PATTERN).test(file.filename) ||
      file.mediaType.length > 255 ||
      !new RegExp(MEDIA_TYPE_PATTERN).test(file.mediaType)
    )
      return invalid("Multipart file metadata is invalid.");
    const expected = descriptor.files[name]?.mediaType;
    if (expected !== undefined && expected !== file.mediaType.toLowerCase())
      return invalid(
        "The multipart file media type does not match its declared contentType.",
      );
    // Check the encoded length before regex matching or allocating decoded bytes.
    if (
      file.dataBase64.length > Math.ceil((maxBytes - bytes) / 3) * 4 ||
      file.dataBase64.length % 4 !== 0 ||
      !new RegExp(BASE64_PATTERN).test(file.dataBase64)
    )
      return invalid("Multipart file data must be bounded canonical base64.");
    const data = Buffer.from(file.dataBase64, "base64");
    if (data.toString("base64") !== file.dataBase64)
      return invalid("Multipart file data must use canonical base64.");
    append({
      name,
      data,
      filename: file.filename,
      mediaType: file.mediaType.toLowerCase(),
    });
  }
  const values = Object.fromEntries(regular);
  checkTextBudget(values, maxBytes);
  for (const [name, value] of new URLSearchParams(
    encodeFormBody(values, descriptor.form),
  )) {
    if (fileNamespaces.has(wireNamespace(name)))
      return invalid("Expanded multipart fields conflict with a file field.");
    append({
      name,
      data: Buffer.from(value),
      mediaType: Object.hasOwn(descriptor.contentTypes, name)
        ? (descriptor.contentTypes[name] ?? "text/plain")
        : "text/plain",
    });
  }
  let boundary = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    boundary = `openapi-mcp-${randomBytes(24).toString("hex")}`;
    if (!parts.some((part) => part.data.includes(boundary))) break;
    if (attempt === 7) return invalid("Could not create a multipart boundary.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const add = (chunk: Buffer): void => {
    total += chunk.length;
    if (total > maxBytes)
      invalid("The multipart request exceeded the configured byte limit.");
    chunks.push(chunk);
  };
  for (const part of parts) {
    add(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? "" : `; filename="${part.filename}"`}\r\nContent-Type: ${part.mediaType}\r\n\r\n`,
      ),
    );
    add(part.data);
    add(Buffer.from("\r\n"));
  }
  add(Buffer.from(`--${boundary}--\r\n`));
  return {
    bytes: Buffer.concat(chunks, total),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};
