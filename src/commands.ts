import { Console, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { HttpApi } from "./api-client.ts";
import { inspectOperationCatalog, loadOperationCatalog } from "./catalog.ts";
import { AdapterConfig, type Configuration } from "./config.ts";
import {
  formatInspection,
  inspectCatalog,
  InspectionError,
} from "./inspection.ts";
import { SERVER_INFO } from "./package-info.ts";
import { createMcpServer, createStdioMcpServer } from "./server.ts";
import { generatedTools } from "./tools.ts";

const loadOptions = (configuration: Configuration) => ({
  baseUrl: Option.getOrUndefined(configuration.baseUrl),
  credentials: configuration.credentials,
  methods: configuration.methods,
  tags: configuration.tags,
  maxSpecBytes: configuration.maxSpecBytes,
  specTimeoutMs: configuration.specTimeoutMs,
  referencesMode: configuration.referencesMode,
  maxReferenceDocuments: configuration.maxReferenceDocuments,
  maxReferenceDepth: configuration.maxReferenceDepth,
  parameterProfile: configuration.parameterProfile,
  toolHeaders: configuration.toolHeaders,
});
const serve = Effect.gen(function* () {
  const configuration = yield* AdapterConfig;
  const catalog = yield* loadOperationCatalog(
    configuration.openApiSpec,
    loadOptions(configuration),
  );
  for (const operation of catalog.unsupported) {
    yield* Effect.logWarning(
      `Unsupported ${operation.method.toUpperCase()} ${operation.path}: ${operation.reason}`,
    );
  }
  yield* Effect.logInfo(
    `MCP tools: ${catalog.operations.length}; filtered: ${catalog.filtered.length}; unsupported: ${catalog.unsupported.length}`,
  );
  const tools = generatedTools(catalog).pipe(Layer.provide(HttpApi.layer));
  const transport =
    configuration.transport === "http"
      ? createMcpServer(tools, {
          port: configuration.port,
          maxRequestBytes: configuration.maxRequestBytes,
        })
      : createStdioMcpServer(tools);
  return yield* Layer.launch(transport);
}).pipe(
  Effect.provide(Layer.mergeAll(AdapterConfig.layer, FetchHttpClient.layer)),
);
const inspection = (
  options: Readonly<{ json: boolean; check: boolean; strict: boolean }>,
) =>
  Effect.gen(function* () {
    const configuration = yield* AdapterConfig;
    const catalog = yield* inspectOperationCatalog(
      configuration.openApiSpec,
      loadOptions(configuration),
    );
    const report = yield* inspectCatalog(catalog);
    yield* Console.log(
      options.json ? JSON.stringify(report, null, 2) : formatInspection(report),
    );
    if (options.check && report.summary.exposed === 0) {
      return yield* new InspectionError({
        message: `No tools can be exposed: ${report.summary.filtered} filtered, ${report.summary.unsupported} unsupported. Review the inspection report and MCP_METHODS/MCP_TAGS.`,
      });
    }
    if (options.strict && report.summary.unsupported > 0) {
      return yield* new InspectionError({
        message: `Strict check failed: ${report.summary.unsupported} unsupported operations.`,
      });
    }
  }).pipe(
    Effect.provide(Layer.mergeAll(AdapterConfig.layer, FetchHttpClient.layer)),
  );
const json = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print a machine-readable catalog and diagnostics."),
);
export const command = Command.make(SERVER_INFO.name, {}, () => serve).pipe(
  Command.withDescription(
    "Expose an OpenAPI document as native Effect MCP tools. Configuration is supplied through MCP_* environment variables.",
  ),
  Command.withSubcommands([
    Command.make("serve", {}, () => serve).pipe(
      Command.withDescription(
        "Run the configured HTTP or stdio MCP transport (also the default command).",
      ),
    ),
    Command.make("inspect", { json }, ({ json }) =>
      inspection({ json, check: false, strict: false }),
    ).pipe(
      Command.withDescription(
        "Inspect tools and exclusions without opening a transport.",
      ),
    ),
    Command.make(
      "check",
      {
        json,
        strict: Flag.Boolean("strict").pipe(
          Flag.withDefault(false),
          Flag.withDescription(
            "Fail if any operation is unsupported; intentional filters are allowed.",
          ),
        ),
      },
      ({ json, strict }) => inspection({ json, check: true, strict }),
    ).pipe(
      Command.withDescription(
        "Validate loading and schema export; fail when no tools remain.",
      ),
    ),
  ]),
);
export const runCommand = Command.runWith(command, {
  version: SERVER_INFO.version,
});
