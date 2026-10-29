import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { createStdioMcpServer, generatedTools } from "effect-openapi-mcp";
import {
  loadProfile,
  mockApi,
  profileNames,
  type Profile,
} from "./profiles.ts";

const profile = process.argv[2] ?? "echo";
if (!profileNames.includes(profile as Profile))
  throw new Error(`Unknown evaluation profile: ${profile}`);
const catalog = loadProfile(profile as Profile).catalog;
const tools = generatedTools(catalog).pipe(
  Layer.provide(mockApi(profile as Profile, process.env.EVALUATION_JOURNAL)),
);
NodeRuntime.runMain(
  Layer.launch(createStdioMcpServer(tools)).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Logger.LogToStderr, true),
  ),
);
