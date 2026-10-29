import { Data, Effect } from "effect";
import { Tool } from "effect/ai";
import type { OperationCatalog } from "./openapi.ts";

export class InspectionError extends Data.TaggedError("InspectionError")<
  Readonly<{ message: string }>
> {}

// Describe the public tool contract; credentials and target URLs never enter this report.
export const inspectCatalog = Effect.fn("openapi.inspect")(function* (
  catalog: OperationCatalog,
) {
  const tools = yield* Effect.forEach(catalog.operations, (operation) =>
    Effect.try({
      try: () => ({
        name: operation.name,
        method: operation.method.toUpperCase(),
        path: operation.path,
        description: operation.description,
        inputSchema: Tool.getJsonSchema(
          Tool.dynamic(operation.name, {
            parameters: operation.parametersSchema,
          }),
        ),
        annotations: operation.annotations,
        serialization: {
          parameters: operation.parameters,
          body: operation.body,
          responses: operation.responses,
          responseContentTypes: operation.responseContentTypes,
          responseTextContentTypes: operation.responseTextContentTypes,
        },
        authentication: operation.authentication.map(
          ({ scheme, location, name }) => ({ scheme, location, name }),
        ),
      }),
      catch: () =>
        new InspectionError({
          message: `Could not export the MCP input schema for ${operation.name}.`,
        }),
    }),
  );
  return {
    summary: {
      exposed: tools.length,
      filtered: catalog.filtered.length,
      unsupported: catalog.unsupported.length,
    },
    tools,
    filtered: catalog.filtered,
    unsupported: catalog.unsupported,
  };
});
export type InspectionReport = Effect.Success<
  ReturnType<typeof inspectCatalog>
>;

export const formatInspection = (report: InspectionReport): string =>
  [
    `Tools: ${report.summary.exposed}; filtered: ${report.summary.filtered}; unsupported: ${report.summary.unsupported}`,
    ...report.tools.map((tool) => `${tool.name}: ${tool.method} ${tool.path}`),
    ...report.filtered.map(
      (item) =>
        `Filtered ${item.method.toUpperCase()} ${item.path}: ${item.reason}`,
    ),
    ...report.unsupported.map(
      (item) =>
        `Unsupported ${item.method.toUpperCase()} ${item.path}: ${item.reason}`,
    ),
  ].join("\n");
