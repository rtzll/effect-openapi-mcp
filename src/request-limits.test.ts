import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeApiClient } from "./api-client.ts";
import { InvalidArguments } from "./api-errors.ts";
import { compileOpenApi } from "./openapi.ts";
import { findOperation } from "./test-fixtures.ts";
import type { JsonValue } from "./openapi-types.ts";

const operation = (contentType: string, schema: unknown) =>
  findOperation(
    compileOpenApi({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/submit": {
          post: {
            operationId: "submit",
            requestBody: {
              required: true,
              content: { [contentType]: { schema } },
            },
            responses: { "204": {} },
          },
        },
      },
    }),
    "submit",
  );
const cases: ReadonlyArray<{
  name: string;
  contentType: string;
  body: JsonValue;
  schema: unknown;
  wire: string;
}> = [
  {
    name: "JSON UTF-8",
    contentType: "application/json",
    body: { value: "é😀" },
    schema: { type: "object" },
    wire: '{"value":"é😀"}',
  },
  {
    name: "JSON escapes and vendor content type",
    contentType: "application/problem+json",
    body: { value: '\n"\\\u0000' },
    schema: { type: "object" },
    wire: '{"value":"\\n\\"\\\\\\u0000"}',
  },
  {
    name: "JSON scalar",
    contentType: "application/json",
    body: "é",
    schema: { type: "string" },
    wire: '"é"',
  },
  {
    name: "JSON null",
    contentType: "application/json",
    body: null,
    schema: { type: "null" },
    wire: "null",
  },
  {
    name: "form percent encoding",
    contentType: "application/x-www-form-urlencoded",
    body: { value: "é😀 +&=" },
    schema: { type: "object", properties: { value: { type: "string" } } },
    wire: "value=%C3%A9%F0%9F%98%80+%2B%26%3D",
  },
  {
    name: "form repeated fields",
    contentType: "application/x-www-form-urlencoded",
    body: { value: ["a+b", "c d"] },
    schema: {
      type: "object",
      properties: { value: { type: "array", items: { type: "string" } } },
    },
    wire: "value=a%2Bb&value=c+d",
  },
];

describe("Encoded upstream request limits", () => {
  it.effect.each(cases)(
    "accepts exact wire bytes and rejects one byte over the limit: $name",
    ({ contentType, body, schema, wire }) =>
      Effect.gen(function* () {
        let requests = 0;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            requests++;
            expect(request.headers["content-type"]).toBe(contentType);
            if (request.body._tag !== "Uint8Array")
              throw new Error("Expected encoded request bytes.");
            expect(new Uint8Array(request.body.body)).toEqual(
              new TextEncoder().encode(wire),
            );
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 204 }),
            );
          }),
        );
        const selected = operation(contentType, schema);
        const size = Buffer.byteLength(wire, "utf8");
        expect(
          yield* makeApiClient(http, 10_000, 1024, size).execute(selected, {
            body,
          }),
        ).toBeNull();
        const failure = yield* Effect.flip(
          makeApiClient(http, 10_000, 1024, size - 1).execute(selected, {
            body,
          }),
        );
        expect(failure).toBeInstanceOf(InvalidArguments);
        expect(failure.message).toBe(
          "The request body exceeded the configured byte limit.",
        );
        expect(requests).toBe(1);
      }),
  );
  it.effect(
    "does not retain request bytes or a consumed budget between calls",
    () =>
      Effect.gen(function* () {
        const bodies: string[] = [];
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag !== "Uint8Array")
              throw new Error("Expected encoded request bytes.");
            bodies.push(new TextDecoder().decode(request.body.body));
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 204 }),
            );
          }),
        );
        const selected = operation("application/json", { type: "string" });
        const api = makeApiClient(http, 10_000, 1024, 4);
        expect(
          yield* Effect.flip(api.execute(selected, { body: "😀" })),
        ).toBeInstanceOf(InvalidArguments);
        yield* Effect.all(
          [
            api.execute(selected, { body: "é" }),
            api.execute(selected, { body: "ok" }),
          ],
          { concurrency: "unbounded" },
        );
        expect(bodies.sort()).toEqual(['"ok"', '"é"']);
      }),
  );
  it.effect(
    "counts empty form bodies and absent optional bodies as zero bytes",
    () =>
      Effect.gen(function* () {
        const bodies: string[] = [];
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag === "Uint8Array")
              bodies.push(new TextDecoder().decode(request.body.body));
            else if (request.body._tag === "Empty") bodies.push("absent");
            else throw new Error("Unexpected request body.");
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 204 }),
            );
          }),
        );
        const selected = operation("application/x-www-form-urlencoded", {
          type: "object",
          properties: {},
        });
        const api = makeApiClient(http, 10_000, 1024, 1);
        yield* api.execute(selected, { body: {} });
        const optional = findOperation(
          compileOpenApi({
            openapi: "3.1.0",
            servers: [{ url: "https://api.example.com" }],
            paths: {
              "/submit": {
                post: { operationId: "submit", responses: { "204": {} } },
              },
            },
          }),
          "submit",
        );
        yield* api.execute(optional, {});
        expect(bodies).toEqual(["", "absent"]);
      }),
  );
});
