import { describe, expect, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { CORPUS, readFixture } from "../scripts/corpus.ts";
import { InvalidResponse } from "./api-errors.ts";
import { makeApiClient } from "./api-client.ts";
import { parseOpenApi } from "./catalog.ts";
import {
  selectRequestMediaType,
  selectResponseMediaTypes,
} from "./media-type.ts";
import { compileOpenApi } from "./openapi.ts";
import { findOperation } from "./test-fixtures.ts";

const operation = (
  responses: object = { "200": { content: { "application/yaml": {} } } },
) =>
  findOperation(
    compileOpenApi({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      paths: { "/config": { get: { operationId: "config", responses } } },
    }),
    "config",
  );
const responseClient = (
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array<ArrayBuffer>>,
  contentType: string | undefined = "application/yaml",
  status = 200,
) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status,
          headers:
            contentType === undefined ? {} : { "Content-Type": contentType },
        }),
      ),
    ),
  );
const bytes = (text: string) => new TextEncoder().encode(text);

describe("YAML response text", () => {
  it("selects YAML responses without enabling YAML request serialization", () => {
    expect(selectRequestMediaType(["application/yaml"])).toBeUndefined();
    expect(
      selectResponseMediaTypes(["application/yaml", "application/pdf"]),
    ).toEqual(["application/yaml"]);
    expect(
      selectResponseMediaTypes(["application/yaml", "application/json"]),
    ).toEqual(["application/json"]);
    const selected = operation();
    expect(selected.responses).toEqual({ "200": "text" });
    expect(selected.responseTextContentTypes).toEqual({
      "200": ["application/yaml"],
    });
  });
  it.effect.each([
    "application/yaml",
    "Application/Yaml; Charset=UTF-8",
    'application/yaml; charset="utf8"',
  ])("preserves YAML source text for %s", (contentType) =>
    Effect.gen(function* () {
      const text =
        "\uFEFF# Café 😀\r\nvalue: &value 001\r\nalias: *value\r\n---\r\n!custom untouched\r\n";
      expect(
        yield* makeApiClient(responseClient(bytes(text), contentType)).execute(
          operation(),
          {},
        ),
      ).toBe(text);
    }),
  );
  it.effect(
    "counts received bytes, preserves split UTF-8 and cancels overflow",
    () =>
      Effect.gen(function* () {
        const text = "name: Café 😀\n";
        const value = bytes(text);
        const http = responseClient(
          new ReadableStream({
            start(controller) {
              controller.enqueue(value.slice(0, value.length - 3));
              controller.enqueue(value.slice(value.length - 3));
              controller.close();
            },
          }),
        );
        expect(
          yield* makeApiClient(http, 10_000, value.length).execute(
            operation(),
            {},
          ),
        ).toBe(text);
        let cancelled = false;
        const tooLarge = responseClient(
          new ReadableStream({
            start(controller) {
              controller.enqueue(value);
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
        const failure = yield* Effect.flip(
          makeApiClient(tooLarge, 10_000, value.length - 1).execute(
            operation(),
            {},
          ),
        );
        expect(failure).toBeInstanceOf(InvalidResponse);
        expect(failure.message).toContain("byte limit");
        expect(cancelled).toBe(true);
      }),
  );
  it.effect("rejects malformed UTF-8 without interpreting YAML", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        makeApiClient(responseClient(new Uint8Array([255, 254]))).execute(
          operation(),
          {},
        ),
      );
      expect(failure).toBeInstanceOf(InvalidResponse);
      expect(failure.message).toBe("The API returned invalid UTF-8.");
    }),
  );
  it.effect.each([
    "application/json",
    "text/plain",
    "application/x-yaml",
    "application/yaml; charset=utf-16",
  ])(
    "rejects undeclared or unsupported response representation %s",
    (contentType) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          makeApiClient(
            responseClient(bytes("value: 1\n"), contentType),
          ).execute(operation(), {}),
        );
        expect(failure).toBeInstanceOf(InvalidResponse);
        expect(failure.message).toContain("unsupported response media type");
      }),
  );
  it.effect("checks the media declared for the actual success status", () =>
    Effect.gen(function* () {
      const selected = operation({
        "200": { content: { "application/yaml": {} } },
        "201": { content: { "text/plain": {} } },
      });
      expect(
        yield* Effect.flip(
          makeApiClient(
            responseClient(bytes("x: 1\n"), "application/yaml", 201),
          ).execute(selected, {}),
        ),
      ).toBeInstanceOf(InvalidResponse);
    }),
  );
  it("continues rejecting sequential response item schemas", () => {
    expect(() =>
      operation({
        "200": {
          content: { "application/yaml": { itemSchema: { type: "object" } } },
        },
      }),
    ).toThrow("Sequential response media");
  });
  it.effect("executes the pinned DigitalOcean kubeconfig operation", () =>
    Effect.gen(function* () {
      const source = CORPUS.find(
        (source) => source.file === "digitalocean-bundled.yaml.gz",
      );
      if (source === undefined) throw new Error("Missing DigitalOcean bundle.");
      const fixture = yield* readFixture(source);
      const catalog = compileOpenApi(parseOpenApi(fixture.text), {
        credentials: { bearer_auth: Redacted.make("fixture-key") },
      });
      const selected = catalog.operations.find(
        (operation) =>
          operation.path === "/v2/kubernetes/clusters/{cluster_id}/kubeconfig",
      );
      if (selected === undefined)
        throw new Error("Missing kubeconfig operation.");
      const text = "apiVersion: v1\nkind: Config\nclusters: []\n";
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.url).toBe(
            "https://api.digitalocean.com/v2/kubernetes/clusters/fixture-cluster/kubeconfig",
          );
          expect(request.headers.authorization).toBe("Bearer fixture-key");
          expect(request.headers.accept).toContain("application/yaml");
          return HttpClientResponse.fromWeb(
            request,
            new Response(text, {
              headers: { "Content-Type": "application/yaml" },
            }),
          );
        }),
      );
      expect(
        yield* makeApiClient(http).execute(selected, {
          path: { cluster_id: "fixture-cluster" },
        }),
      ).toBe(text);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
