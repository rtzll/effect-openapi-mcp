import { Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";
import { compileOpenApi, HttpApi, makeApiClient } from "effect-openapi-mcp";

// Compilation is deterministic; execution depends on the HttpApi service.
const catalog = compileOpenApi({
  openapi: "3.1.2",
  servers: [{ url: "https://inventory.example.com/v1" }],
  paths: {
    "/items/{id}": {
      get: {
        operationId: "get_item",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { content: { "application/json": {} } } },
      },
    },
  },
});
const operation = catalog.operations[0];
if (operation === undefined)
  throw new Error("The example operation is missing.");

export const lookupItem = Effect.fn("example.lookupItem")(function* (
  id: string,
) {
  const api = yield* HttpApi;
  // Direct library consumers validate arguments as the generated MCP tools do.
  const input = yield* Schema.decodeEffect(operation.parametersSchema)({
    path: { id },
  });
  return yield* api.execute(operation, input);
});

// This layer leaves the HTTP implementation available for callers to substitute.
export const ApiLayer = Layer.effect(
  HttpApi,
  Effect.map(HttpClient.HttpClient, (http) => makeApiClient(http)),
);
