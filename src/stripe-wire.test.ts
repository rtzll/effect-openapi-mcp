import { createServer } from "node:http";
import { NodeHttpServer, NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  HttpClient,
  HttpClientResponse,
} from "effect/http";
import { CORPUS, readFixture } from "../scripts/corpus.ts";
import { parseOpenApi } from "./catalog.ts";
import { OPENAPI_SCHEMA } from "./openapi-types.ts";
import { compileOpenApi } from "./openapi.ts";
import { makeApiClient } from "./api-client.ts";

it.layer(NodeFileSystem.layer)("Pinned Stripe request encoding", (it) => {
  it.effect("executes schema-valid metadata and empty expansion inputs", () =>
    Effect.gen(function* () {
      const source = CORPUS.find((entry) => entry.name === "Stripe GA");
      if (source === undefined) throw new Error("Missing Stripe fixture");
      const fixture = yield* readFixture(source);
      const document = yield* Schema.decodeUnknownEffect(OPENAPI_SCHEMA)(
        parseOpenApi(fixture.text),
      );
      const catalog = compileOpenApi(document, {
        credentials: { bearerAuth: Redacted.make("fixture-token") },
      });
      expect(catalog.operations).toHaveLength(644);
      expect(catalog.unsupported).toEqual([]);
      for (const test of [
        {
          path: "/v1/account",
          method: "get",
          input: { query: { expand: [] } },
          expected: "",
        },
        {
          path: "/v1/customers",
          method: "post",
          input: { body: { metadata: {} } },
          expected: "",
        },
        {
          path: "/v1/customers",
          method: "post",
          input: { body: { metadata: { "123": "Café + 😀" } } },
          expected: "metadata%5B123%5D=Caf%C3%A9+%2B+%F0%9F%98%80",
        },
        {
          path: "/v1/customers",
          method: "post",
          input: { body: { metadata: "" } },
          expected: "metadata=",
        },
      ] as const) {
        const operation = catalog.operations.find(
          (item) => item.path === test.path && item.method === test.method,
        );
        if (operation === undefined)
          throw new Error("Missing Stripe operation");
        const input = yield* Schema.decodeEffect(operation.parametersSchema)(
          test.input,
        );
        let dispatched = false;
        const api = makeApiClient(
          HttpClient.make((request) => {
            dispatched = true;
            expect(request.url).toBe(`https://api.stripe.com${test.path}`);
            expect(request.headers.authorization).toBe("Bearer fixture-token");
            if (test.method === "post") {
              expect(request.body._tag).toBe("Uint8Array");
              if (request.body._tag !== "Uint8Array")
                throw new Error("Expected form bytes");
              expect(new TextDecoder().decode(request.body.body)).toBe(
                test.expected,
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ id: "fixture" }),
              ),
            );
          }),
        );
        yield* api.execute(operation, input);
        expect(dispatched).toBe(true);
      }
    }),
  );
});

// Field expectations were checked against stripe-node 23.0.1's serializer.
// Expected fields are Stripe's documented indexed format. Compare parsed pairs so
// percent-encoded brackets and '+' versus '%20' remain equivalent on the wire.
it.live(
  "sends pinned Stripe query and form requests through a real HTTP listener",
  () =>
    Effect.gen(function* () {
      const captured: Array<{
        url: string;
        body: string;
        headers: Readonly<Record<string, string>>;
      }> = [];
      yield* HttpServer.serveEffect(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          captured.push({
            url: request.url,
            body: yield* request.text,
            headers: request.headers,
          });
          return HttpServerResponse.jsonUnsafe({ id: "fixture" });
        }),
      );
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag === "UnixPathAddress")
        throw new Error("Expected TCP listener");
      const source = CORPUS.find((entry) => entry.name === "Stripe GA");
      if (source === undefined) throw new Error("Missing Stripe fixture");
      const fixture = yield* readFixture(source);
      const document = yield* Schema.decodeUnknownEffect(OPENAPI_SCHEMA)(
        parseOpenApi(fixture.text),
      );
      const paths = ["/v1/customers", "/v1/checkout/sessions"];
      const catalog = compileOpenApi(
        {
          ...document,
          paths: Object.fromEntries(
            paths.map((path) => [path, document.paths[path]]),
          ),
        },
        {
          baseUrl: new URL(`http://127.0.0.1:${server.address.port}`),
          toolHeaders: ["Idempotency-Key"],
          credentials: { bearerAuth: Redacted.make("fixture-token") },
        },
      );
      const api = makeApiClient(
        yield* HttpClient.HttpClient,
        10000,
        undefined,
        undefined,
        {
          "Stripe-Version": Redacted.make("2026-09-30.endive"),
          "Stripe-Account": Redacted.make("acct_fixture"),
        },
      );
      for (const test of [
        {
          path: paths[0],
          method: "get",
          input: {
            query: {
              expand: ["data.default_source"],
              created: { gte: 1700000000 },
              limit: 2,
            },
          },
          fields: [
            ["expand[0]", "data.default_source"],
            ["created[gte]", "1700000000"],
            ["limit", "2"],
          ],
        },
        {
          path: paths[1],
          method: "post",
          input: {
            headers: { "Idempotency-Key": "checkout-fixture" },
            body: {
              mode: "payment",
              success_url: "https://example.com/success",
              line_items: [{ price: "price_fixture", quantity: 2 }],
              metadata: { "123": "Café + 😀" },
            },
          },
          fields: [
            ["mode", "payment"],
            ["success_url", "https://example.com/success"],
            ["line_items[0][price]", "price_fixture"],
            ["line_items[0][quantity]", "2"],
            ["metadata[123]", "Café + 😀"],
          ],
        },
      ] as const) {
        const operation = catalog.operations.find(
          (entry) => entry.path === test.path && entry.method === test.method,
        );
        if (operation === undefined) throw new Error("Missing operation");
        const input = yield* Schema.decodeEffect(operation.parametersSchema)(
          test.input,
        );
        yield* api.execute(operation, input);
        const request = captured.at(-1);
        if (request === undefined) throw new Error("No HTTP request received");
        const url = new URL(request.url, "http://localhost");
        expect(url.pathname).toBe(test.path);
        const pairs =
          test.method === "get"
            ? url.searchParams
            : new URLSearchParams(request.body);
        expect([...pairs].sort(([a], [b]) => a.localeCompare(b))).toEqual(
          test.fields
            .map((entry) => [...entry])
            .sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
        );
        expect(request.headers.authorization).toBe("Bearer fixture-token");
        expect(request.headers["stripe-version"]).toBe("2026-09-30.endive");
        expect(request.headers["stripe-account"]).toBe("acct_fixture");
        if (test.method === "post")
          expect(request.headers["idempotency-key"]).toBe("checkout-fixture");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeFileSystem.layer,
          FetchHttpClient.layer,
          NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" }),
        ),
      ),
    ),
);
