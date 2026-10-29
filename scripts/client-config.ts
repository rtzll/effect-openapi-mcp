import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Logger } from "effect";
import { createClientConfig } from "./client-config-program.ts";

NodeRuntime.runMain(
  createClientConfig().pipe(
    Effect.flatMap((config) => Console.log(JSON.stringify(config, null, 2))),
    Effect.provide(NodeServices.layer),
    Effect.provideService(Logger.LogToStderr, true),
  ),
);
