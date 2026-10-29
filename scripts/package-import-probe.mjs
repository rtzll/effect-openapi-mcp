import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Adapter from "effect-openapi-mcp";

for (const name of [
  "compileOpenApi",
  "analyzeOpenApi",
  "loadOperationCatalog",
  "bundleOpenApi",
  "HttpApi",
  "makeApiClient",
  "generatedTools",
  "createMcpServer",
  "createStdioMcpServer",
  "AdapterConfig",
]) {
  assert.ok(name in Adapter, `Missing public export: ${name}`);
}
assert.throws(() => import.meta.resolve("effect-openapi-mcp/dist/index.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
const consumer = realpathSync(dirname(fileURLToPath(import.meta.url)));
const entry = import.meta.resolve("effect-openapi-mcp");
const require = createRequire(entry);
for (const [name, file] of [
  ["effect-openapi-mcp", fileURLToPath(entry)],
  ...["effect", "@effect/platform-node", "yaml"].map((name) => [
    name,
    require.resolve(name),
  ]),
]) {
  const resolved = realpathSync(file);
  const path = relative(consumer, resolved);
  assert.ok(
    !isAbsolute(path) && path.split(sep)[0] !== "..",
    `${name} escaped consumer`,
  );
}
const catalog = Adapter.compileOpenApi({
  openapi: "3.2.1",
  servers: [{ url: "https://mock.example.com/v1" }],
  paths: {
    "/items/{id}": {
      get: {
        operationId: "get_item",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", minLength: 1 },
          },
        ],
        responses: { 200: { content: { "application/json": {} } } },
      },
    },
  },
});
assert.equal(catalog.operations.length, 1);
const operation = catalog.operations[0];
assert.ok(operation);
assert.equal(operation.name, "get_item");
const MockHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    assert.equal(request.url, "https://mock.example.com/v1/items/item-1");
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json({ id: "item-1" })),
    );
  }),
);
const Api = Layer.effect(
  Adapter.HttpApi,
  Effect.map(HttpClient.HttpClient, (http) => Adapter.makeApiClient(http)),
).pipe(Layer.provide(MockHttp));
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const api = yield* Adapter.HttpApi;
    const input = yield* Schema.decodeEffect(operation.parametersSchema)({
      path: { id: "item-1" },
    });
    return yield* api.execute(operation, input);
  }).pipe(Effect.provide(Api)),
);
assert.deepEqual(result, { id: "item-1" });
console.log(
  "Bare-name public imports and native Effect service composition passed in the fresh consumer.",
);
