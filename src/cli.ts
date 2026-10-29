#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { Command } from "effect/cli";
import { command } from "./commands.ts";
import { SERVER_INFO } from "./package-info.ts";

NodeRuntime.runMain(
  Command.run(command, { version: SERVER_INFO.version }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
        ),
      ),
    ),
    Effect.provideService(Logger.LogToStderr, true),
  ),
);
