import { ByteSize, Data, Effect, Stream } from "effect";

export const DEFAULT_MAX_SPEC_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export class TextReadError extends Data.TaggedError("TextReadError")<
  Readonly<{ reason: "size" | "encoding" }>
> {}

// Count received bytes, including decompressed HTTP bytes, rather than trusting Content-Length.
// The decoder is scoped to one evaluation and flushed to detect truncated final UTF-8 characters.
export const readBoundedText = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
  options: Readonly<{ preserveBOM?: boolean }> = {},
): Effect.Effect<string, E | TextReadError, R> =>
  Effect.suspend(() => {
    const decoder = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: options.preserveBOM === true,
    });
    const decode = (chunk?: Uint8Array) =>
      Effect.try({
        try: () => decoder.decode(chunk, { stream: chunk !== undefined }),
        catch: () => new TextReadError({ reason: "encoding" }),
      });
    return source.pipe(
      Stream.limitBytes<E | TextReadError, R>(ByteSize.bytes(maxBytes), () =>
        Stream.fail(new TextReadError({ reason: "size" })),
      ),
      Stream.mapEffect(decode),
      Stream.mkString,
      Effect.flatMap((text) =>
        decode().pipe(Effect.map((last) => text + last)),
      ),
    );
  });
