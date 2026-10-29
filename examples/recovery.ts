import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { ApiLayer } from "./library-program.ts";
import {
  lookupItemWithFallback,
  RateLimitedHttpClient,
} from "./recovery-program.ts";

NodeRuntime.runMain(
  lookupItemWithFallback("item-1").pipe(
    Effect.flatMap((item) => Console.log(JSON.stringify(item))),
    Effect.provide(ApiLayer.pipe(Layer.provide(RateLimitedHttpClient))),
  ),
);
