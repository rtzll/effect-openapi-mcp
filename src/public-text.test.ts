import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Ref, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { CORPUS, readFixture } from "../scripts/corpus.ts";
import { InvalidResponse } from "./api-errors.ts";
import { makeApiClient } from "./api-client.ts";
import { parseOpenApi } from "./catalog.ts";
import { compileOpenApi } from "./openapi.ts";

const MARKDOWN = "**Café**\r\n😀";
const RAW_HTML = "\uFEFF<p><strong>Café</strong> 😀</p>\r\n";
const JSON_HTML = "<p>Café <strong>world</strong></p>\n";
const ZEN = "Responsive is better than fast.\r\nCafé 😀\n";

it.effect.each(["github-3.0.json.gz", "github-3.1.json.gz"])(
  "executes public raw markdown, JSON markdown and zen text contracts (%s)",
  (file) =>
    Effect.gen(function* () {
      const source = CORPUS.find((source) => source.file === file);
      if (source === undefined)
        return yield* Effect.die("Missing pinned GitHub fixture");
      const fixture = yield* readFixture(source);
      const catalog = compileOpenApi(parseOpenApi(fixture.text), {
        tags: ["markdown", "meta"],
      });
      const raw = catalog.operations.find(
        (operation) =>
          operation.method === "post" && operation.path === "/markdown/raw",
      );
      const render = catalog.operations.find(
        (operation) =>
          operation.method === "post" && operation.path === "/markdown",
      );
      const zen = catalog.operations.find(
        (operation) => operation.method === "get" && operation.path === "/zen",
      );
      if (raw === undefined || render === undefined || zen === undefined)
        return yield* Effect.die("Missing public text fixture operations");
      expect(raw.body).toEqual({ mode: "text", contentType: "text/plain" });
      expect(raw.responses["200"]).toBe("text");
      expect(raw.responseTextContentTypes?.["200"]).toEqual(["text/html"]);
      expect(render.body).toEqual({
        mode: "json",
        contentType: "application/json",
      });
      expect(render.responseTextContentTypes?.["200"]).toEqual(["text/html"]);
      expect(zen.responses["200"]).toBe("text");
      expect(zen.responseTextContentTypes?.["200"]).toEqual(["text/plain"]);
      const rawInput = yield* Schema.decodeEffect(raw.parametersSchema, {
        onExcessProperty: "error",
      })({ body: MARKDOWN });
      const renderInput = yield* Schema.decodeEffect(render.parametersSchema, {
        onExcessProperty: "error",
      })({ body: { text: "Café **world**", mode: "markdown" } });
      const zenInput = yield* Schema.decodeEffect(zen.parametersSchema, {
        onExcessProperty: "error",
      })({});
      for (const body of [null, 42, { text: MARKDOWN }])
        expect(
          Result.isFailure(Schema.decodeResult(raw.parametersSchema)({ body })),
        ).toBe(true);
      for (const body of [{}, { text: MARKDOWN, mode: "unsupported" }])
        expect(
          Result.isFailure(
            Schema.decodeResult(render.parametersSchema)({ body }),
          ),
        ).toBe(true);
      const requests = yield* Ref.make<
        Array<{
          method: string;
          url: string;
          body: string;
          bytes: number[];
          contentType: string | undefined;
          accept: string | undefined;
        }>
      >([]);
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Ref.update(requests, (previous) => [
            ...previous,
            {
              method: request.method,
              url: request.url,
              body:
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "",
              bytes:
                request.body._tag === "Uint8Array"
                  ? [...request.body.body]
                  : [],
              contentType: request.headers["content-type"],
              accept: request.headers.accept,
            },
          ]);
          const response = request.url.endsWith("/markdown/raw")
            ? { body: RAW_HTML, contentType: "text/html; charset=UTF-8" }
            : request.url.endsWith("/markdown")
              ? { body: JSON_HTML, contentType: "text/html" }
              : request.url.endsWith("/zen")
                ? { body: ZEN, contentType: "text/plain; charset=utf-8" }
                : undefined;
          if (response === undefined)
            return yield* Effect.die("Unexpected public fixture URL");
          return HttpClientResponse.fromWeb(
            request,
            new Response(new TextEncoder().encode(response.body), {
              headers: { "Content-Type": response.contentType },
            }),
          );
        }),
      );
      const api = makeApiClient(http);
      expect(yield* api.execute(raw, rawInput)).toBe(RAW_HTML);
      expect(yield* api.execute(render, renderInput)).toBe(JSON_HTML);
      expect(yield* api.execute(zen, zenInput)).toBe(ZEN);
      const observed = yield* Ref.get(requests);
      expect(observed[0]).toEqual({
        method: "POST",
        url: "https://api.github.com/markdown/raw",
        body: MARKDOWN,
        bytes: [
          0x2a, 0x2a, 0x43, 0x61, 0x66, 0xc3, 0xa9, 0x2a, 0x2a, 0x0d, 0x0a,
          0xf0, 0x9f, 0x98, 0x80,
        ],
        contentType: "text/plain",
        accept: "text/html",
      });
      expect(observed[1]).toMatchObject({
        method: "POST",
        url: "https://api.github.com/markdown",
        body: '{"text":"Café **world**","mode":"markdown"}',
        contentType: "application/json",
        accept: "text/html",
      });
      expect(observed[2]).toEqual({
        method: "GET",
        url: "https://api.github.com/zen",
        body: "",
        bytes: [],
        contentType: undefined,
        accept: "text/plain",
      });
      expect(observed).toHaveLength(3);
      for (const [operation, input, contentType] of [
        [raw, rawInput, "text/plain"],
        [zen, zenInput, "text/html"],
      ] as const) {
        const wrongMedia = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("private-response-body", {
                headers: { "Content-Type": contentType },
              }),
            ),
          ),
        );
        const error = yield* Effect.flip(
          makeApiClient(wrongMedia).execute(operation, input),
        );
        expect(error).toBeInstanceOf(InvalidResponse);
        expect(JSON.stringify(error)).not.toContain("private-response-body");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);
