import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { HttpApi, structuredResult } from "./api-client.ts";
import { API_FAILURE_SCHEMA } from "./api-errors.ts";
import type { OperationCatalog } from "./openapi.ts";
import type { OperationArguments } from "./schema.ts";

export const generatedTools = (catalog: OperationCatalog) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const client = yield* HttpApi;
      const tools = catalog.operations.map((operation) =>
        Tool.dynamic(operation.name, {
          description: operation.description,
          parameters: operation.parametersSchema,
          success: Schema.JsonObject,
          failure: API_FAILURE_SCHEMA,
        })
          .annotate(Tool.Strict, true)
          .annotate(Tool.Readonly, operation.annotations.readOnlyHint)
          .annotate(Tool.Destructive, operation.annotations.destructiveHint)
          .annotate(Tool.Idempotent, operation.annotations.idempotentHint)
          .annotate(Tool.OpenWorld, operation.annotations.openWorldHint),
      );
      const toolkit = Toolkit.make(...tools);
      const handlers = Object.fromEntries(
        catalog.operations.map((operation) => [
          operation.name,
          Effect.fn("mcp.tool")(function* (input: OperationArguments) {
            yield* Effect.annotateCurrentSpan("mcp.tool.name", operation.name);
            return structuredResult(yield* client.execute(operation, input));
          }),
        ]),
      );
      return McpServer.toolkit(toolkit).pipe(
        Layer.provide(toolkit.toLayer(handlers)),
      );
    }),
  );
