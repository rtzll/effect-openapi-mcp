import { describe, expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Ref, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { InvalidArguments } from "./api-errors.ts";
import { makeApiClient } from "./api-client.ts";
import {
  compileOpenApi,
  type CompileOptions,
  type OperationDescriptor,
} from "./openapi.ts";
import type { JsonSchema, JsonValue } from "./openapi-types.ts";

const VERSIONS = ["3.0.4", "3.1.2", "3.2.1"];
const RESPONSES = { "200": { content: { "application/json": {} } } };
const TEXT_SCHEMA = {
  type: "string",
  minLength: 3,
  maxLength: 64,
  pattern: "^é😀",
};
const CODE_SCHEMA = {
  type: "string",
  minLength: 2,
  maxLength: 10,
  pattern: "^[a-z]+$",
};
const STRING_ARRAY = {
  type: "array",
  minItems: 1,
  maxItems: 4,
  items: { type: "string", maxLength: 64 },
};
const SCALAR_SCHEMA: JsonSchema = {
  anyOf: [
    { type: "string", maxLength: 64 },
    { type: "integer", minimum: -999, maximum: 999 },
    { type: "boolean" },
  ],
};
const TREE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["zero", "disabled", "empty", "meta", "rows"],
  properties: {
    zero: { type: "integer", enum: [0] },
    disabled: { type: "boolean", enum: [false] },
    empty: { type: "string", enum: [""] },
    meta: {
      type: "object",
      additionalProperties: false,
      required: ["é + &", "percent%5B"],
      properties: { "é + &": TEXT_SCHEMA, "percent%5B": SCALAR_SCHEMA },
    },
    rows: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "flags", "values"],
        properties: {
          name: TEXT_SCHEMA,
          flags: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "boolean" },
          },
          values: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: SCALAR_SCHEMA,
          },
        },
      },
    },
  },
};
const BRACKETS = { style: "deepObject", explode: false };
const PROFILE: CompileOptions = { parameterProfile: "brackets-indexed" };

// Construct Unicode strings rather than filtering arbitrary UTF-16. Mapping retains
// the native shrink tree, including an empty suffix and separator-bearing tokens.
const unicode = Arbitrary.schema(
  Schema.Array(
    Schema.Literals([
      "a",
      "é",
      "e\u0301",
      "😀",
      "👩‍💻",
      " ",
      "+",
      "&",
      "=",
      ",",
      "|",
      "/",
      "?",
      "#",
      "%",
      "[x]",
      "\r\n",
      "\uFEFF",
    ]),
  ).check(Schema.isMaxLength(8)),
).pipe(Arbitrary.map((tokens) => "é😀a" + tokens.join("")));
const code = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(10),
  Schema.isPattern(/^[a-z]+$/u),
);
const scalar = Arbitrary.schema(
  Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: -999, maximum: 999 })),
    Schema.Boolean,
    Schema.Literals(["", "é😀", "&=,+| /%", "0", "false"]),
  ]),
);
const tree = Arbitrary.all({
  zero: Arbitrary.Constant(0),
  disabled: Arbitrary.Constant(false),
  empty: Arbitrary.Constant(""),
  meta: Arbitrary.all({ "é + &": unicode, "percent%5B": scalar }),
  rows: Arbitrary.array(
    Arbitrary.all({
      name: unicode,
      flags: Arbitrary.schema(
        Schema.Array(Schema.Boolean)
          .check(Schema.isMinLength(1), Schema.isMaxLength(3))
          .pipe(Schema.mutable),
      ),
      values: Arbitrary.array(scalar, { minLength: 1, maxLength: 3 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
});
const separated = Arbitrary.array(
  unicode.pipe(Arbitrary.map((value) => value + ",| +&=%")),
  { minLength: 1, maxLength: 4 },
);
const propertyOptions = (seed: string) => ({
  // @effect/vitest reports a replay token and minimizes failures with this budget.
  arbitrary: { seed, runs: 100, size: 12, maxShrinks: 100 },
});
const parameter = (
  name: string,
  location: "path" | "query",
  schema: JsonSchema,
  encoding: object = {},
) => ({ name, in: location, required: true, schema, ...encoding });
const body = (
  contentType: string,
  schema: JsonSchema,
  encoding: object = {},
) => ({ required: true, content: { [contentType]: { schema, ...encoding } } });
const object = (properties: Record<string, JsonSchema>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const operation = (
  openapi: string,
  path: string,
  method: "get" | "post",
  definition: object,
  options: CompileOptions = {},
): OperationDescriptor => {
  const catalog = compileOpenApi(
    {
      openapi,
      servers: [{ url: "https://api.example.com/v1/" }],
      paths: { [path]: { [method]: { responses: RESPONSES, ...definition } } },
    },
    options,
  );
  expect(catalog.unsupported).toEqual([]);
  const selected = catalog.operations[0];
  if (selected === undefined) throw new Error("Missing generated operation");
  return selected;
};

type CapturedRequest = Readonly<{
  url: string;
  body: string | undefined;
  contentType: string | undefined;
}>;
const mockHttpClient = Effect.gen(function* () {
  const requests = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const content =
        request.body._tag === "Uint8Array"
          ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              request.body.body,
            )
          : undefined;
      yield* Ref.update(requests, (previous) => [
        ...previous,
        {
          url: request.url,
          body: content,
          contentType: request.headers["content-type"],
        },
      ]);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ accepted: true }),
      );
    }),
  );
  const api = makeApiClient(client);
  const execute = (descriptor: OperationDescriptor, input: unknown) =>
    Schema.decodeUnknownEffect(descriptor.parametersSchema, {
      onExcessProperty: "error",
    })(input).pipe(
      Effect.flatMap((decoded) => api.execute(descriptor, decoded)),
    );
  return { requests, execute };
});
const requestAt = (
  requests: ReadonlyArray<CapturedRequest>,
  index: number,
): CapturedRequest => {
  const request = requests[index];
  if (request === undefined) throw new Error("Missing captured request");
  return request;
};
const requestBody = (request: CapturedRequest): string => {
  if (request.body === undefined) throw new Error("Missing captured body");
  return request.body;
};
const rawParameter = (encoded: string, name: string): string => {
  const matches = encoded
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair.startsWith(name + "="));
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) throw new Error("Missing raw parameter");
  return match.slice(name.length + 1);
};
const stringLeaves = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(stringLeaves);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, stringLeaves(child)]),
    );
  return String(value);
};
type Leaf = Readonly<{ path: ReadonlyArray<string>; value: string }>;
// Independent inverse: parse decoded bracket paths, group each level, and reconstruct
// arrays only from contiguous indices. This never calls or copies the wire encoder.
const readBracketNode = (leaves: ReadonlyArray<Leaf>): JsonValue => {
  const terminal = leaves.find((leaf) => leaf.path.length === 0);
  if (terminal !== undefined) {
    expect(leaves).toHaveLength(1);
    return terminal.value;
  }
  const groups = new Map<string, Leaf[]>();
  for (const leaf of leaves) {
    const [segment, ...path] = leaf.path;
    if (segment === undefined) throw new Error("Missing bracket segment");
    groups.set(segment, [
      ...(groups.get(segment) ?? []),
      { path, value: leaf.value },
    ]);
  }
  const entries = [...groups].map(
    ([segment, children]) => [segment, readBracketNode(children)] as const,
  );
  if (entries.every(([segment]) => /^(0|[1-9]\d*)$/u.test(segment))) {
    entries.sort(([left], [right]) => Number(left) - Number(right));
    expect(entries.map(([segment]) => Number(segment))).toEqual(
      entries.map((_, index) => index),
    );
    return entries.map(([, value]) => value);
  }
  return Object.fromEntries(entries);
};
const readBrackets = (parameters: URLSearchParams): JsonValue => {
  const leaves = [...parameters].map(([key, value]) => {
    expect(key).toMatch(/^filter(?:\[[^[\]]+\])*$/u);
    return {
      path: [...key.matchAll(/\[([^[\]]+)\]/gu)].map((match) => {
        const segment = match[1];
        if (segment === undefined) throw new Error("Missing parsed segment");
        return segment;
      }),
      value,
    };
  });
  return readBracketNode(leaves);
};

describe.each(VERSIONS)("Generated HTTP execution (%s)", (version) => {
  const scalars = operation(version, "/items/{id}", "get", {
    parameters: [
      parameter("id", "path", { type: "string", minLength: 1, maxLength: 64 }),
      parameter("text", "query", TEXT_SCHEMA),
      parameter("code", "query", CODE_SCHEMA),
      parameter("number", "query", {
        type: "integer",
        minimum: -999,
        maximum: 999,
      }),
      parameter("enabled", "query", { type: "boolean" }),
    ],
  });
  const scalarBody = object({ text: TEXT_SCHEMA, code: CODE_SCHEMA });
  const form = operation(version, "/forms", "post", {
    requestBody: body("application/x-www-form-urlencoded", scalarBody),
  });
  const text = operation(version, "/text", "post", {
    requestBody: body("text/plain; charset=utf-8", TEXT_SCHEMA),
  });
  const json = operation(version, "/json", "post", {
    requestBody: body("application/json", scalarBody),
  });
  const arrayParameters = [
    parameter("repeated", "query", STRING_ARRAY, {
      style: "form",
      explode: true,
    }),
    parameter("csv", "query", STRING_ARRAY, { style: "form", explode: false }),
  ];
  const arrays = operation(version, "/arrays", "get", {
    parameters: arrayParameters,
  });
  const arrayForm = operation(version, "/array-forms", "post", {
    requestBody: body(
      "application/x-www-form-urlencoded",
      object({ repeated: STRING_ARRAY, csv: STRING_ARRAY }),
      {
        encoding: {
          repeated: { style: "form", explode: true },
          csv: { style: "form", explode: false },
        },
      },
    ),
  });
  const bracketQuery = operation(
    version,
    "/brackets",
    "get",
    {
      parameters: [parameter("filter", "query", TREE_SCHEMA, BRACKETS)],
    },
    PROFILE,
  );
  const bracketForm = operation(
    version,
    "/bracket-forms",
    "post",
    {
      requestBody: body(
        "application/x-www-form-urlencoded",
        object({ filter: TREE_SCHEMA }),
        { encoding: { filter: BRACKETS } },
      ),
    },
    PROFILE,
  );
  const queryCollision = operation(
    version,
    "/query-collision",
    "get",
    {
      parameters: [
        parameter("filter", "query", TREE_SCHEMA, BRACKETS),
        parameter("filter[meta]", "query", { type: "string" }),
      ],
    },
    PROFILE,
  );
  const formCollision = operation(
    version,
    "/form-collision",
    "post",
    {
      requestBody: body(
        "application/x-www-form-urlencoded",
        object({ filter: TREE_SCHEMA, "filter[meta]": { type: "string" } }),
        { encoding: { filter: BRACKETS } },
      ),
    },
    PROFILE,
  );
  const opaqueBracket = operation(
    version,
    "/opaque-brackets",
    "get",
    {
      parameters: [
        parameter(
          "filter",
          "query",
          { type: "object", additionalProperties: true },
          BRACKETS,
        ),
      ],
    },
    PROFILE,
  );
  const delimiterOperations = ["spaceDelimited", "pipeDelimited"].map((style) =>
    operation(version, "/delimited", "get", {
      parameters: [
        parameter("values", "query", STRING_ARRAY, { style, explode: false }),
      ],
    }),
  );

  it.effect.prop(
    "preserves Unicode scalars through path, query, form, text and JSON",
    {
      value: unicode,
      code,
      number: Schema.Int.check(
        Schema.isBetween({ minimum: -999, maximum: 999 }),
      ),
      enabled: Schema.Boolean,
    },
    ({ value, code, number, enabled }) =>
      Effect.gen(function* () {
        const fixture = yield* mockHttpClient;
        const input = { text: value, code };
        for (const [descriptor, arguments_] of [
          [
            scalars,
            { path: { id: value }, query: { ...input, number, enabled } },
          ],
          [form, { body: input }],
          [text, { body: value }],
          [json, { body: input }],
        ] as const)
          expect(yield* fixture.execute(descriptor, arguments_)).toEqual({
            accepted: true,
          });
        const requests = yield* Ref.get(fixture.requests);
        expect(requests).toHaveLength(4);
        const query = new URL(requestAt(requests, 0).url);
        expect(query.origin).toBe("https://api.example.com");
        expect(query.hash).toBe("");
        expect(
          decodeURIComponent(query.pathname.slice("/v1/items/".length)),
        ).toBe(value);
        expect([...query.searchParams]).toEqual([
          ["text", value],
          ["code", code],
          ["number", String(number)],
          ["enabled", String(enabled)],
        ]);
        expect([
          ...new URLSearchParams(requestBody(requestAt(requests, 1))),
        ]).toEqual(Object.entries(input));
        expect(requestAt(requests, 1).contentType).toBe(
          "application/x-www-form-urlencoded",
        );
        expect(requestBody(requestAt(requests, 2))).toBe(value);
        expect(requestAt(requests, 2).contentType).toBe(
          "text/plain; charset=utf-8",
        );
        const decodedJson: unknown = JSON.parse(
          requestBody(requestAt(requests, 3)),
        );
        expect(decodedJson).toEqual(input);
      }),
    propertyOptions("execution-scalars:" + version),
  );

  it.effect.prop(
    "preserves separator-bearing repeated and CSV arrays",
    { values: separated },
    ({ values }) =>
      Effect.gen(function* () {
        const fixture = yield* mockHttpClient;
        yield* fixture.execute(arrays, {
          query: { repeated: values, csv: values },
        });
        yield* fixture.execute(arrayForm, {
          body: { repeated: values, csv: values },
        });
        const requests = yield* Ref.get(fixture.requests);
        expect(requests).toHaveLength(2);
        const query = new URL(requestAt(requests, 0).url);
        expect(query.searchParams.getAll("repeated")).toEqual(values);
        expect(
          rawParameter(query.search, "csv").split(",").map(decodeURIComponent),
        ).toEqual(values);
        const encodedForm = requestBody(requestAt(requests, 1));
        expect(new URLSearchParams(encodedForm).getAll("repeated")).toEqual(
          values,
        );
        expect(
          rawParameter(encodedForm, "csv")
            .split(",")
            .map((value) => decodeURIComponent(value.replace(/\+/g, " "))),
        ).toEqual(values);
      }),
    propertyOptions("execution-arrays:" + version),
  );

  it.effect.prop(
    "reconstructs indexed bracket trees without losing false, zero or empty strings",
    { value: tree },
    ({ value }) =>
      Effect.gen(function* () {
        const fixture = yield* mockHttpClient;
        yield* fixture.execute(bracketQuery, { query: { filter: value } });
        yield* fixture.execute(bracketForm, { body: { filter: value } });
        const requests = yield* Ref.get(fixture.requests);
        expect(requests).toHaveLength(2);
        expect(
          readBrackets(new URL(requestAt(requests, 0).url).searchParams),
        ).toEqual(stringLeaves(value));
        expect(
          readBrackets(
            new URLSearchParams(requestBody(requestAt(requests, 1))),
          ),
        ).toEqual(stringLeaves(value));
      }),
    propertyOptions("execution-brackets:" + version),
  );

  it.effect.prop(
    "rejects invalid mutations and namespace collisions before dispatch",
    { value: tree, text: unicode, code },
    ({ value, text: inputText, code }) =>
      Effect.gen(function* () {
        const fixture = yield* mockHttpClient;
        const validQuery = { text: inputText, code, number: 0, enabled: false };
        for (const invalidCode of [
          "",
          code.toUpperCase(),
          code + "x".repeat(11),
        ]) {
          const failure = yield* Effect.flip(
            fixture.execute(scalars, {
              path: { id: inputText },
              query: { ...validQuery, code: invalidCode },
            }),
          );
          expect(Schema.isSchemaError(failure)).toBe(true);
        }
        for (const invalidNumber of [-1000, 1000, 1.5]) {
          const failure = yield* Effect.flip(
            fixture.execute(scalars, {
              path: { id: inputText },
              query: { ...validQuery, number: invalidNumber },
            }),
          );
          expect(Schema.isSchemaError(failure)).toBe(true);
        }
        for (const invalidBody of [
          "é",
          inputText.replace(/^é😀/u, "xx"),
          inputText + "x".repeat(65),
        ]) {
          const failure = yield* Effect.flip(
            fixture.execute(text, { body: invalidBody }),
          );
          expect(Schema.isSchemaError(failure)).toBe(true);
        }
        for (const invalidRows of [[], Array(4).fill(value.rows[0])]) {
          const failure = yield* Effect.flip(
            fixture.execute(bracketQuery, {
              query: { filter: { ...value, rows: invalidRows } },
            }),
          );
          expect(Schema.isSchemaError(failure)).toBe(true);
        }
        for (const invalidPath of ["", ".", "..", inputText + "\ud800"]) {
          const failure = yield* Effect.flip(
            fixture.execute(scalars, {
              path: { id: invalidPath },
              query: validQuery,
            }),
          );
          if (invalidPath === "")
            expect(Schema.isSchemaError(failure)).toBe(true);
          else expect(failure).toBeInstanceOf(InvalidArguments);
        }
        for (const [descriptor, arguments_] of [
          [text, { body: inputText + "\ud800" }],
          [
            queryCollision,
            { query: { filter: value, "filter[meta]": inputText } },
          ],
          [
            formCollision,
            { body: { filter: value, "filter[meta]": inputText } },
          ],
          [opaqueBracket, { query: { filter: { child: null } } }],
        ] as const) {
          const failure = yield* Effect.flip(
            fixture.execute(descriptor, arguments_),
          );
          expect(failure).toBeInstanceOf(InvalidArguments);
        }
        for (const descriptor of delimiterOperations) {
          const failure = yield* Effect.flip(
            fixture.execute(descriptor, {
              query: { values: [inputText + " |"] },
            }),
          );
          expect(failure).toBeInstanceOf(InvalidArguments);
        }
        expect(yield* Ref.get(fixture.requests)).toEqual([]);
      }),
    propertyOptions("execution-rejections:" + version),
  );
});
