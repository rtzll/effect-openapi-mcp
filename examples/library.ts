import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ApiLayer, lookupItem } from "./library-program.ts";

// The example is offline. Swap this layer for FetchHttpClient.layer to call
// a real API after configuring its server URL and credentials in the catalog.
const DemoHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ id: "item-1", label: "Notebook" }),
      ),
    ),
  ),
);

const program = lookupItem("item-1").pipe(Effect.flatMap(Console.log));

// Resources and interruption remain owned by Effect until the application boundary.
NodeRuntime.runMain(
  program.pipe(Effect.provide(ApiLayer.pipe(Layer.provide(DemoHttpClient)))),
);
