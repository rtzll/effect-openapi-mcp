import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import INVENTORY_SPEC from "../examples/inventory.openapi.json" with { type: "json" };
import { makeApiClient, HttpApi } from "./api-client.ts";
import {
  compileOpenApi,
  type CompileOptions,
  type OperationCatalog,
  type OperationDescriptor,
} from "./openapi.ts";
import { createMcpServer } from "./server.ts";
import { generatedTools } from "./tools.ts";

export { INVENTORY_SPEC };

export const API_RESPONSES = {
  "200": { content: { "application/json": { schema: { type: "object" } } } },
};
export const TEST_KEY = "private-upstream-test-key";
export const TEST_CREDENTIALS = { Key: Redacted.make(TEST_KEY) };
export const TICKETING_SPEC = {
  openapi: "3.0.3",
  info: { title: "Ticketing", version: "2.0" },
  servers: [{ url: "https://tickets.example.com/api" }],
  security: [{ AccessToken: [] }],
  components: {
    securitySchemes: { AccessToken: { type: "http", scheme: "bearer" } },
  },
  paths: {
    "/tickets/{number}": {
      get: {
        operationId: "get_ticket",
        parameters: [
          {
            in: "path",
            name: "number",
            required: true,
            schema: { type: "integer", minimum: 1 },
          },
        ],
        responses: API_RESPONSES,
      },
    },
    "/tickets": {
      post: {
        operationId: "create_ticket",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subject"],
                properties: {
                  subject: { type: "string" },
                  assignee: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        responses: API_RESPONSES,
      },
    },
  },
};
export const inventoryCatalog = (options: CompileOptions = {}) =>
  compileOpenApi(INVENTORY_SPEC, { credentials: TEST_CREDENTIALS, ...options });
export const findOperation = (
  catalog: OperationCatalog,
  name: string,
): OperationDescriptor => {
  const operation = catalog.operations.find(
    (operation) => operation.name === name,
  );
  if (operation === undefined) {
    throw new Error(`Missing test operation: ${name}`);
  }
  return operation;
};
export const accepts = (operation: OperationDescriptor, value: unknown) =>
  Result.isSuccess(
    Schema.decodeUnknownResult(operation.parametersSchema, {
      onExcessProperty: "error",
    })(value),
  );
export const testServerLayer = (
  catalog: OperationCatalog,
  timeoutMs = 1000,
  limits: Readonly<{
    maxRequestBytes?: number;
    maxResponseBytes?: number;
  }> = {},
) => {
  const api = Layer.effect(
    HttpApi,
    Effect.map(HttpClient.HttpClient, (http) =>
      makeApiClient(
        http,
        timeoutMs,
        limits.maxResponseBytes,
        limits.maxRequestBytes,
      ),
    ),
  );
  return createMcpServer(generatedTools(catalog), {
    port: 0,
    logAddress: false,
    maxRequestBytes: limits.maxRequestBytes,
  }).pipe(Layer.provide(api), Layer.provide(FetchHttpClient.layer));
};
