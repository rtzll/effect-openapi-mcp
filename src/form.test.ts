import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "@effect/vitest";
import { makeApiClient } from "./api-client.ts";
import { InvalidArguments } from "./api-errors.ts";
import { compileOpenApi } from "./openapi.ts";
import { encodeFormBody } from "./form.ts";
import { API_RESPONSES, accepts, findOperation } from "./test-fixtures.ts";

const compile = (
  schema: unknown,
  encoding: unknown = {},
  version = "3.1.2",
  components: object = {},
) =>
  compileOpenApi(
    {
      openapi: version,
      components,
      servers: [{ url: "https://forms.example.com/api" }],
      paths: {
        "/health": { get: { responses: API_RESPONSES } },
        "/forms": {
          post: {
            operationId: "submit",
            requestBody: {
              required: true,
              content: {
                "application/x-www-form-urlencoded": { schema, encoding },
              },
            },
            responses: API_RESPONSES,
          },
        },
      },
    },
    { parameterProfile: "spec" },
  );
const flat = {
  type: "object",
  additionalProperties: false,
  properties: { city: { type: "string" }, active: { type: "boolean" } },
};
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 0 },
    enabled: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    filter: flat,
    rows: { type: "array", items: flat },
  },
};
const bodyText = (
  body: ReturnType<typeof compile>["operations"][number]["body"],
  value: Parameters<typeof encodeFormBody>[0],
) => {
  if (body?.mode !== "form") throw new Error("Expected form descriptor");
  return encodeFormBody(value, body.form);
};

describe("Strict OpenAPI form serialization", () => {
  it.each(["3.1.2", "3.2.1"])(
    "diagnoses root reference siblings before exposing an unencodable body (%s)",
    (version) => {
      const catalog = compile(
        {
          $ref: "#/components/schemas/Body",
          properties: { second: { type: "string" } },
          required: ["second"],
        },
        {},
        version,
        {
          schemas: {
            Body: { type: "object", properties: { first: { type: "string" } } },
          },
        },
      );
      expect(catalog.operations.map((operation) => operation.name)).toEqual([
        "get_health",
      ]);
      expect(catalog.unsupported).toEqual([
        {
          method: "post",
          path: "/forms",
          reason:
            "Form schema $ref siblings are not supported (properties, required); inline the effective schema for form serialization.",
        },
      ]);
    },
  );
  it.each(["3.1.2", "3.2.1"])(
    "checks meaningful siblings throughout root reference chains (%s)",
    (version) => {
      const catalog = compile(
        { $ref: "#/components/schemas/Alias" },
        {},
        version,
        {
          schemas: {
            Alias: { $ref: "#/components/schemas/Body", required: ["first"] },
            Body: { type: "object", properties: { first: { type: "string" } } },
          },
        },
      );
      expect(catalog.unsupported[0]?.reason).toContain(
        "$ref siblings are not supported (required)",
      );
    },
  );
  it.each(["3.1.2", "3.2.1"])(
    "does not discard serialization constraints on field or array-item references (%s)",
    (version) => {
      for (const sibling of [
        { format: "binary" },
        { format: "byte" },
        { contentEncoding: "base64" },
      ]) {
        const field = { $ref: "#/components/schemas/Text", ...sibling };
        for (const value of [field, { type: "array", items: field }]) {
          const catalog = compile(
            { type: "object", properties: { value } },
            {},
            version,
            { schemas: { Text: { type: "string" } } },
          );
          expect(catalog.unsupported).toHaveLength(1);
          expect(catalog.unsupported[0]?.reason).toContain(
            "Form schema $ref siblings are not supported",
          );
        }
      }
    },
  );
  it.each(["3.0.4", "3.1.2", "3.2.1"])(
    "preserves annotated references without changing form validation or encoding (%s)",
    (version) => {
      const catalog = compile(
        {
          $ref: "#/components/schemas/Body",
          description: "A form",
          title: "Request",
        },
        {},
        version,
        {
          schemas: {
            Body: {
              type: "object",
              required: ["value"],
              properties: {
                value: {
                  $ref: "#/components/schemas/Text",
                  description: "A field",
                },
              },
            },
            Text: { type: "string", minLength: 1 },
          },
        },
      );
      const operation = findOperation(catalog, "submit");
      expect(catalog.unsupported).toEqual([]);
      expect(accepts(operation, { body: { value: "ok" } })).toBe(true);
      expect(accepts(operation, { body: { value: "" } })).toBe(false);
      expect(bodyText(operation.body, { value: "a b" })).toBe("value=a+b");
    },
  );
  it("ignores root and field reference siblings in OpenAPI 3.0", () => {
    const catalog = compile(
      {
        $ref: "#/components/schemas/Body",
        properties: { second: { type: "string" } },
        required: ["second"],
      },
      {},
      "3.0.4",
      {
        schemas: {
          Body: {
            type: "object",
            properties: {
              first: { $ref: "#/components/schemas/Text", format: "binary" },
            },
          },
          Text: { type: "string" },
        },
      },
    );
    const operation = findOperation(catalog, "submit");
    expect(catalog.unsupported).toEqual([]);
    expect(accepts(operation, { body: { first: "ok" } })).toBe(true);
    expect(operation.body).toMatchObject({
      form: { fields: { first: { mode: "auto" } } },
    });
    expect(bodyText(operation.body, { first: "a b" })).toBe("first=a+b");
  });
  it.each(["3.1.2", "3.2.1"])(
    "retains native sibling validation when explicit JSON field encoding needs no inference (%s)",
    (version) => {
      const operation = findOperation(
        compile(
          {
            type: "object",
            properties: {
              value: { $ref: "#/components/schemas/Text", minLength: 2 },
            },
          },
          { value: { contentType: "application/json" } },
          version,
          { schemas: { Text: { type: "string" } } },
        ),
        "submit",
      );
      expect(accepts(operation, { body: { value: "ok" } })).toBe(true);
      expect(accepts(operation, { body: { value: "a" } })).toBe(false);
      expect(bodyText(operation.body, { value: "ok" })).toBe("value=%22ok%22");
    },
  );
  it.effect.each(["3.0.4", "3.1.2", "3.2.1"])(
    "sends a native Effect HTTP form with its schema intact (%s)",
    (version) =>
      Effect.gen(function* () {
        const operation = findOperation(
          compile(
            {
              ...schema,
              properties: {
                ...schema.properties,
                nested: {
                  type: "array",
                  items: { type: "array", items: { type: "integer" } },
                },
              },
            },
            { nested: { contentType: "application/json" } },
            version,
          ),
          "submit",
        );
        expect(accepts(operation, { body: { name: "ok", count: 0 } })).toBe(
          true,
        );
        expect(accepts(operation, { body: { name: "", count: -1 } })).toBe(
          false,
        );
        expect(accepts(operation, {})).toBe(false);
        const http = HttpClient.make((request) => {
          expect(request.method).toBe("POST");
          expect(request.url).toBe("https://forms.example.com/api/forms");
          expect(request.headers["content-type"]).toBe(
            "application/x-www-form-urlencoded",
          );
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag !== "Uint8Array")
            throw new Error("Expected encoded bytes");
          expect(new TextDecoder().decode(request.body.body)).toBe(
            "name=A+B%2BC%26%3D%C3%A9&count=0&enabled=false&tags=one+two&tags=three%2Cfour&filter=%7B%22city%22%3A%22Paris%22%2C%22active%22%3Atrue%7D&rows=%7B%22city%22%3A%22Rome%22%7D&nested=%5B1%2C2%5D",
          );
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("{}", {
                headers: { "Content-Type": "application/json" },
              }),
            ),
          );
        });
        yield* makeApiClient(http).execute(operation, {
          body: {
            name: "A B+C&=é",
            count: 0,
            enabled: false,
            tags: ["one two", "three,four"],
            filter: { city: "Paris", active: true },
            rows: [{ city: "Rome" }],
            nested: [[1, 2]],
          },
        });
      }),
  );

  it.each([
    [
      "form",
      false,
      { city: "A,B", active: false },
      "filter=city,A%2CB,active,false",
    ],
    ["form", true, { city: "A B", active: false }, "city=A+B&active=false"],
    [
      "deepObject",
      true,
      { city: "A+B", active: false },
      "filter%5Bcity%5D=A%2BB&filter%5Bactive%5D=false",
    ],
  ])(
    "honors explicit %s object encoding (explode=%s)",
    (style, explode, value, expected) => {
      const operation = findOperation(
        compile(
          { type: "object", properties: { filter: flat } },
          { filter: { style, explode, contentType: "ignored/by-style" } },
        ),
        "submit",
      );
      expect(bodyText(operation.body, { filter: value })).toBe(expected);
    },
  );

  it.each([
    ["form", false, "tags=one%2Btwo,three%2Cfour"],
    ["form", true, "tags=one%2Btwo&tags=three%2Cfour"],
    ["spaceDelimited", false, "tags=one%2Btwo%20three%2Cfour"],
    ["pipeDelimited", false, "tags=one%2Btwo%7Cthree%2Cfour"],
  ])(
    "honors explicit %s array encoding (explode=%s)",
    (style, explode, expected) => {
      const operation = findOperation(
        compile(schema, { tags: { style, explode } }),
        "submit",
      );
      expect(
        bodyText(operation.body, { tags: ["one+two", "three,four"] }),
      ).toBe(expected);
    },
  );

  it("allows explicitly JSON-encoded primitives, objects and null", () => {
    const operation = findOperation(
      compile(
        { type: "object", properties: { value: true } },
        { value: { contentType: "application/json" } },
      ),
      "submit",
    );
    expect(bodyText(operation.body, { value: "quoted" })).toBe(
      "value=%22quoted%22",
    );
    expect(bodyText(operation.body, { value: null })).toBe("value=null");
  });

  it("applies explicit JSON and text content types to each array item", () => {
    const operation = findOperation(
      compile(schema, { tags: { contentType: "application/json" } }),
      "submit",
    );
    expect(bodyText(operation.body, { tags: ["a", "b"] })).toBe(
      "tags=%22a%22&tags=%22b%22",
    );
    const text = findOperation(
      compile(schema, { tags: { contentType: "text/plain" } }),
      "submit",
    );
    expect(bodyText(text.body, { tags: ["a b", "c"] })).toBe("tags=a+b&tags=c");
  });
  it("rejects expanded name collisions and fields with no declared encoding", () => {
    const operation = findOperation(
      compile(
        {
          type: "object",
          properties: { filter: flat, city: { type: "string" } },
        },
        { filter: { style: "form", explode: true } },
      ),
      "submit",
    );
    expect(() =>
      bodyText(operation.body, { filter: { city: "a" }, city: "b" }),
    ).toThrow("conflicting wire names");
    expect(() => bodyText(operation.body, { unknown: "value" })).toThrow(
      "No encoding is declared",
    );
  });
  it.effect("fails ambiguous null values before sending a request", () =>
    Effect.gen(function* () {
      let sent = false;
      const operation = findOperation(
        compile(
          {
            type: "object",
            properties: { value: { type: ["string", "null"] } },
          },
          { value: { style: "form" } },
        ),
        "submit",
      );
      const http = HttpClient.make((request) => {
        sent = true;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("{}")),
        );
      });
      const error = yield* Effect.flip(
        makeApiClient(http).execute(operation, { body: { value: null } }),
      );
      expect(error).toBeInstanceOf(InvalidArguments);
      expect(sent).toBe(false);
    }),
  );

  it.each([
    ["deepObject arrays", { tags: { style: "deepObject", explode: true } }],
    ["deepObject primitives", { name: { style: "deepObject", explode: true } }],
    [
      "exploded spaceDelimited",
      { tags: { style: "spaceDelimited", explode: true } },
    ],
    ["allowReserved", { name: { allowReserved: true } }],
    ["unsupported media", { name: { contentType: "application/xml" } }],
    ["text object", { filter: { contentType: "text/plain" } }],
    ["unknown property", { missing: { style: "form" } }],
    ["nested encoding", { name: { encoding: {} } }],
  ])(
    "diagnoses %s without exposing a changed wire contract",
    (_name, encoding) => {
      expect(
        compile(
          {
            ...schema,
            properties: { ...schema.properties, nested: { type: "string" } },
          },
          encoding,
        ).unsupported,
      ).toHaveLength(1);
    },
  );

  it.each(["spaceDelimited", "pipeDelimited"])(
    "rejects ambiguous %s form separators",
    (style) => {
      const operation = findOperation(
        compile(schema, { tags: { style, explode: false } }),
        "submit",
      );
      expect(() =>
        bodyText(operation.body, {
          tags: [style === "spaceDelimited" ? "a b" : "a|b"],
        }),
      ).toThrow("separator character");
    },
  );
  it("rejects malformed Unicode in scalar form values instead of replacing it", () => {
    const operation = findOperation(compile(schema), "submit");
    expect(() => bodyText(operation.body, { name: "\ud800" })).toThrow(
      "well-formed Unicode",
    );
  });
  it("diagnoses nested styled objects, binary properties and non-object bodies", () => {
    expect(
      compile(
        {
          type: "object",
          properties: {
            filter: {
              type: "object",
              additionalProperties: false,
              properties: { nested: flat },
            },
          },
        },
        { filter: { style: "deepObject", explode: true } },
      ).unsupported,
    ).toHaveLength(1);
    expect(
      compile({
        type: "object",
        properties: { file: { type: "string", format: "binary" } },
      }).unsupported,
    ).toHaveLength(1);
    expect(compile({ type: "array", items: flat }).unsupported).toHaveLength(1);
  });
});
