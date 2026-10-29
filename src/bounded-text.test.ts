import { Effect, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { readBoundedText } from "./bounded-text.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
describe("Bounded UTF-8 streams", () => {
  it.effect(
    "accepts the exact byte limit and split multi-byte characters",
    () =>
      Effect.gen(function* () {
        const encoded = bytes("aé😀");
        const source = Stream.make(
          encoded.slice(0, 2),
          encoded.slice(2, 5),
          encoded.slice(5),
        );
        expect(yield* readBoundedText(source, encoded.length)).toBe("aé😀");
      }),
  );
  it.effect(
    "fails before retaining a chunk that crosses the byte limit and closes the stream",
    () =>
      Effect.gen(function* () {
        let finalized = false;
        const source = Stream.make(bytes("12"), bytes("345")).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        );
        expect(yield* Effect.flip(readBoundedText(source, 4))).toHaveProperty(
          "reason",
          "size",
        );
        expect(finalized).toBe(true);
      }),
  );
  it.effect.each([
    new Uint8Array([0xc3]),
    new Uint8Array([0xff]),
    new Uint8Array([0xc3, 0x28]),
  ])("rejects incomplete or malformed UTF-8", (chunk) =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(readBoundedText(Stream.make(chunk), 10)),
      ).toHaveProperty("reason", "encoding");
    }),
  );
  it.effect("preserves a leading BOM only when explicitly requested", () =>
    Effect.gen(function* () {
      const source = Stream.make(bytes("\uFEFFtext"));
      expect(yield* readBoundedText(source, 7)).toBe("text");
      expect(yield* readBoundedText(source, 7, { preserveBOM: true })).toBe(
        "\uFEFFtext",
      );
    }),
  );
  it.effect("allocates fresh decoder and limit state for each evaluation", () =>
    Effect.gen(function* () {
      const program = readBoundedText(Stream.make(bytes("é")), 2);
      expect(
        yield* Effect.all([program, program], { concurrency: "unbounded" }),
      ).toEqual(["é", "é"]);
      expect(yield* program).toBe("é");
    }),
  );
});
