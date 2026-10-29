import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import {
  cancelInFlightRequest,
  makeCancellationRequest,
} from "../examples/cancellation-program.ts";

describe("offline cancellation example", () => {
  it.effect(
    "ends successfully after interrupting the native HTTP request",
    () =>
      Effect.gen(function* () {
        expect(yield* cancelInFlightRequest()).toEqual({
          cancelled: true,
          starts: 1,
          interruptions: 1,
          finalizations: 1,
          signalAborted: true,
        });
      }),
  );

  it.effect(
    "waits for request start and finalizes exactly once across scope closure",
    () =>
      Effect.gen(function* () {
        const demo = yield* makeCancellationRequest();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const request = yield* demo.request.pipe(Effect.forkScoped);
            yield* Deferred.await(demo.started);
            expect(demo.observations()).toEqual({
              starts: 1,
              interruptions: 0,
              finalizations: 0,
              signalAborted: false,
            });
            yield* Fiber.interrupt(request);
            expect(Exit.hasInterrupts(yield* Fiber.await(request))).toBe(true);
            yield* Deferred.await(demo.finalized);
          }),
        );
        expect(demo.observations()).toEqual({
          starts: 1,
          interruptions: 1,
          finalizations: 1,
          signalAborted: true,
        });
      }),
  );
});
