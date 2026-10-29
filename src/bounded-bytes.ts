import { ByteSize, Data, Effect, Stream } from "effect";

export class ByteReadError extends Data.TaggedError("ByteReadError")<
  Readonly<{ reason: "size" }>
> {}

/** Count actual streamed bytes before collecting or base64-encoding a response. */
export const readBoundedBytes = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
): Effect.Effect<Uint8Array, E | ByteReadError, R> =>
  source.pipe(
    Stream.limitBytes<E | ByteReadError, R>(ByteSize.bytes(maxBytes), () =>
      Stream.fail(new ByteReadError({ reason: "size" })),
    ),
    Stream.runFold(
      () => ({ buffer: Buffer.alloc(0), length: 0 }),
      (state, chunk) => {
        const length = state.length + chunk.length;
        if (length > state.buffer.length) {
          const capacity = Math.min(
            maxBytes,
            Math.max(8192, state.buffer.length * 2, length),
          );
          const buffer = Buffer.alloc(capacity);
          buffer.set(state.buffer.subarray(0, state.length));
          state.buffer = buffer;
        }
        state.buffer.set(chunk, state.length);
        state.length = length;
        return state;
      },
    ),
    Effect.map(({ buffer, length }) => buffer.subarray(0, length)),
  );
