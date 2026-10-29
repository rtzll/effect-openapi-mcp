import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Logger } from "effect";
import { runDemo } from "./demo-program.ts";

NodeRuntime.runMain(
  runDemo().pipe(
    Effect.flatMap((lines) => Console.log(lines.join("\n"))),
    Effect.provideService(Logger.LogToStderr, true),
  ),
);
