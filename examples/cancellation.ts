import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { cancelInFlightRequest } from "./cancellation-program.ts";

NodeRuntime.runMain(
  cancelInFlightRequest().pipe(
    Effect.flatMap((result) => Console.log(JSON.stringify(result))),
  ),
);
