import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  compileOpenApi,
  createStdioMcpServer,
  generatedTools,
  HttpApi,
  makeApiClient,
} from "effect-openapi-mcp";

// A client-owned stdio process with two anonymous, read-only tools and no network.
const catalog = compileOpenApi({
  openapi: "3.2.1",
  servers: [{ url: "https://mock.example.com/v1" }],
  paths: {
    "/message": {
      get: {
        operationId: "echo_message",
        summary: "Echo a short message and a count without external API calls.",
        parameters: [
          {
            name: "message",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 64 },
          },
          {
            name: "count",
            in: "query",
            required: true,
            schema: { type: "integer", minimum: 1, maximum: 10 },
          },
        ],
        responses: { "200": { content: { "application/json": {} } } },
      },
    },
    "/text": {
      query: {
        operationId: "echo_text",
        summary: "Echo Unicode text exactly without external API calls.",
        requestBody: {
          required: true,
          content: {
            "text/plain": {
              schema: { type: "string", minLength: 1, maxLength: 64 },
            },
          },
        },
        responses: { "200": { content: { "text/plain": {} } } },
      },
    },
  },
});

const MockHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const response = url.pathname.endsWith("/message")
        ? Response.json({
            message: url.searchParams.get("message"),
            count: Number(url.searchParams.get("count")),
          })
        : new Response(
            request.body._tag === "Uint8Array" ? request.body.body : null,
            { headers: { "Content-Type": "text/plain; charset=utf-8" } },
          );
      return HttpClientResponse.fromWeb(request, response);
    }),
  ),
);
const Api = Layer.effect(
  HttpApi,
  Effect.map(HttpClient.HttpClient, (http) => makeApiClient(http)),
);
const tools = generatedTools(catalog).pipe(
  Layer.provide(Api.pipe(Layer.provide(MockHttp))),
);

NodeRuntime.runMain(
  Layer.launch(createStdioMcpServer(tools)).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Logger.LogToStderr, true),
  ),
);
