import { Deferred, Effect, Exit, Fiber } from "effect";
import { HttpClient } from "effect/http";
import { compileOpenApi, makeApiClient } from "effect-openapi-mcp";

const catalog = compileOpenApi({
  openapi: "3.1.2",
  servers: [{ url: "https://inventory.example.com/v1" }],
  paths: {
    "/items": {
      get: { responses: { "200": { content: { "application/json": {} } } } },
    },
  },
});
const operation = catalog.operations[0];
if (operation === undefined)
  throw new Error("The example operation is missing.");

// Each execution owns its synchronization and observations; importing starts no I/O.
export const makeCancellationRequest = Effect.fn(
  "example.makeCancellationRequest",
)(function* () {
  const started = yield* Deferred.make<void>();
  const finalized = yield* Deferred.make<void>();
  let starts = 0;
  let interruptions = 0;
  let finalizations = 0;
  let signal: AbortSignal | undefined;

  const http = HttpClient.make((_request, _url, abortSignal) =>
    Effect.scoped(
      Effect.gen(function* () {
        signal = abortSignal;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalizations += 1;
          }).pipe(Effect.andThen(Deferred.succeed(finalized, undefined))),
        );
        starts += 1;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interruptions += 1;
            }),
          ),
        );
      }),
    ),
  );

  return {
    request: makeApiClient(http).execute(operation, {}),
    started,
    finalized,
    observations: () => ({
      starts,
      interruptions,
      finalizations,
      signalAborted: signal?.aborted ?? false,
    }),
  };
});

export const cancelInFlightRequest = Effect.fn("example.cancelInFlightRequest")(
  function* () {
    const demo = yield* makeCancellationRequest();
    const request = yield* demo.request.pipe(Effect.forkScoped);
    yield* Deferred.await(demo.started);

    // interrupt waits for the fiber; await observes its Exit without re-failing
    // this parent effect with the child's intended interruption.
    yield* Fiber.interrupt(request);
    const exit = yield* Fiber.await(request);
    yield* Deferred.await(demo.finalized);
    return { cancelled: Exit.hasInterrupts(exit), ...demo.observations() };
  },
  Effect.scoped,
);
