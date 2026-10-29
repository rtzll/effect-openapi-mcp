import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { ByteSize, Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import {
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { SERVER_INFO } from "./package-info.ts";
import { DEFAULT_MAX_REQUEST_BYTES } from "./bounded-text.ts";

const PROTOCOLS = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
] as const;

const localRequest = (maxRequestBytes: number) =>
  HttpRouter.middleware((httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const host = request.headers.host;
      if (
        host === undefined ||
        !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(host)
      ) {
        return HttpServerResponse.empty({ status: 403 });
      }
      const origin = request.headers.origin;
      if (origin !== undefined) {
        if (origin !== `http://${host}`) {
          return HttpServerResponse.empty({ status: 403 });
        }
      }
      const contentLength = request.headers["content-length"];
      if (
        contentLength !== undefined &&
        /^\d+$/.test(contentLength) &&
        BigInt(contentLength) > BigInt(maxRequestBytes)
      ) {
        return HttpServerResponse.empty({ status: 413 });
      }
      // Keep native body limits, cancellation and caching. Validate lazily so
      // the MCP transport still performs its header checks before reading bytes.
      let bodyTooLarge = false;
      const text = yield* Effect.cached(
        Effect.flatMap(
          request.arrayBuffer.pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                bodyTooLarge =
                  error.reason._tag === "RequestParseError" &&
                  error.reason.reason === "BodyTooLarge";
              }),
            ),
          ),
          (body) =>
            Effect.try({
              try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
              catch: () =>
                new HttpServerError.HttpServerError({
                  reason: new HttpServerError.RequestParseError({
                    request,
                    description: "The request body must contain valid UTF-8.",
                  }),
                }),
            }),
        ),
      );
      const strictRequest = new Proxy(request, {
        get(target, property): unknown {
          return property === "text" ? text : Reflect.get(target, property);
        },
      });
      const response = yield* httpEffect.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          strictRequest,
        ),
        Effect.provideService(
          HttpServerRequest.MaxBodySize,
          ByteSize.bytes(maxRequestBytes),
        ),
      );
      // MCP turns body-read failures into HTTP 200 parse errors. Preserve the
      // native size rejection now that Node drains overflow instead of resetting.
      return bodyTooLarge
        ? HttpServerResponse.empty({ status: 413 })
        : response;
    }),
  ).layer;

// Build the shared registry and finish registration before exposing a transport.
// Transport layers start a server fiber; providing them to the tools instead
// lets an early client discover an empty or incomplete catalog.
const registeredTools = <A, E, R>(tools: Layer.Layer<A, E, R>) =>
  tools.pipe(Layer.provideMerge(McpServer.McpServer.layer));

export const createStdioMcpServer = <A, E, R>(tools: Layer.Layer<A, E, R>) =>
  McpServer.layerStdio({
    ...SERVER_INFO,
    protocols: PROTOCOLS,
  }).pipe(Layer.provideMerge(registeredTools(tools)));

export const createMcpServer = <A, E, R>(
  tools: Layer.Layer<A, E, R>,
  options: Readonly<{
    port: number;
    logAddress?: boolean;
    maxRequestBytes?: number;
  }>,
) => {
  const transport = Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag === "UnixPathAddress") {
        return yield* Effect.die("The local MCP server requires a TCP server.");
      }
      const port = server.address.port;
      return McpServer.layerHttp({
        ...SERVER_INFO,
        path: "/mcp",
        allowedOrigins: [
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
        ],
        protocols: PROTOCOLS,
      });
    }),
  );
  const routes = transport.pipe(
    Layer.provideMerge(registeredTools(tools)),
    Layer.provide(
      localRequest(options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES),
    ),
  );
  return HttpRouter.serve(routes, {
    disableLogger: true,
    disableListenLog: options.logAddress === false,
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        port: options.port,
        host: "127.0.0.1",
        // Close request scopes before the listener to release interrupted requests.
        disablePreemptiveShutdown: true,
      }),
    ),
  );
};
