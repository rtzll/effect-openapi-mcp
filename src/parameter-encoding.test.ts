import { describe, expect, it } from "@effect/vitest";
import {
  encodeParameter,
  encodeStyled,
  formEncode,
  type QueryEncoding,
} from "./parameter-encoding.ts";
import {
  isBracketSegment,
  MAX_BRACKET_BYTES,
  MAX_BRACKET_DEPTH,
  MAX_BRACKET_PAIRS,
  wireNamespace,
} from "./parameter-profile.ts";
import { InvalidArguments } from "./api-errors.ts";
import type { JsonObject, JsonValue } from "./openapi-types.ts";

const BRACKETS: QueryEncoding = {
  style: "deepObject",
  explode: false,
  profile: "brackets-indexed",
};
const wire = (
  pairs: ReadonlyArray<readonly [string, string]>,
  encode = encodeParameter,
) => pairs.map(([name, value]) => `${encode(name)}=${value}`).join("&");

describe("Style expansion edge cases", () => {
  it.each([
    { style: "form", explode: false },
    { style: "form", explode: true },
    { style: "spaceDelimited", explode: false },
    { style: "pipeDelimited", explode: false },
  ] satisfies QueryEncoding[])(
    "omits an empty $style array but preserves one empty item",
    (encoding) => {
      expect(encodeStyled("items", [], encoding)).toEqual([]);
      expect(encodeStyled("items", [""], encoding)).toEqual([["items", ""]]);
    },
  );
  it.each([false, true])("omits empty form objects (explode=%s)", (explode) => {
    expect(encodeStyled("filter", {}, { style: "form", explode })).toEqual([]);
  });
  it("preserves zero and false style scalars", () => {
    expect(encodeStyled("n", 0, { style: "form", explode: false })).toEqual([
      ["n", "0"],
    ]);
    expect(
      encodeStyled("flag", false, { style: "form", explode: true }),
    ).toEqual([["flag", "false"]]);
  });
  it.each(["\ud800", "\udc00"])(
    "rejects unpaired surrogates in form text",
    (value) => {
      expect(() => formEncode(value)).toThrow("well-formed Unicode");
    },
  );
});

describe("Explicit indexed bracket serialization", () => {
  it.each<[JsonValue, string]>([
    [0, "0"],
    [false, "false"],
    ["", ""],
    ["a + b", "a%20%2B%20b"],
    ["👩‍💻", "%F0%9F%91%A9%E2%80%8D%F0%9F%92%BB"],
  ])("preserves scalar roots (%j)", (value, expected) => {
    expect(encodeStyled("filter", value, BRACKETS)).toEqual([
      ["filter", expected],
    ]);
  });
  it("serializes nested objects and zero-based indexed arrays in stable traversal order", () => {
    const value: JsonObject = {
      tags: ["first", "second"],
      rules: [{ range: { minimum: 0 }, active: false }, { label: "" }],
      groups: [["a"], ["b"]],
    };
    const pairs = encodeStyled("filter", value, BRACKETS);
    expect(pairs).toEqual([
      ["filter[tags][0]", "first"],
      ["filter[tags][1]", "second"],
      ["filter[rules][0][range][minimum]", "0"],
      ["filter[rules][0][active]", "false"],
      ["filter[rules][1][label]", ""],
      ["filter[groups][0][0]", "a"],
      ["filter[groups][1][0]", "b"],
    ]);
    expect(wire(pairs)).toContain(
      "filter%5Brules%5D%5B0%5D%5Brange%5D%5Bminimum%5D=0",
    );
  });
  it.each([false, true])(
    "does not change the explicit indexed convention with explode=%s",
    (explode) => {
      expect(
        encodeStyled("ids", ["a", 0, false], { ...BRACKETS, explode }),
      ).toEqual([
        ["ids[0]", "a"],
        ["ids[1]", "0"],
        ["ids[2]", "false"],
      ]);
    },
  );
  it("uses the supplied query or form escaper for names and values", () => {
    const value = { "label &": "Café + tea", 状态: "🫖" };
    expect(wire(encodeStyled("filter q", value, BRACKETS))).toBe(
      "filter%20q%5Blabel%20%26%5D=Caf%C3%A9%20%2B%20tea&filter%20q%5B%E7%8A%B6%E6%80%81%5D=%F0%9F%AB%96",
    );
    expect(
      wire(encodeStyled("filter q", value, BRACKETS, formEncode), formEncode),
    ).toBe(
      "filter+q%5Blabel+%26%5D=Caf%C3%A9+%2B+tea&filter+q%5B%E7%8A%B6%E6%80%81%5D=%F0%9F%AB%96",
    );
  });
  it("allows shared acyclic objects and plain objects without a prototype", () => {
    const shared = { leaf: "same" };
    const value: JsonObject = { a: shared, b: shared };
    Object.setPrototypeOf(value, null);
    expect(encodeStyled("q", value, BRACKETS)).toEqual([
      ["q[a][leaf]", "same"],
      ["q[b][leaf]", "same"],
    ]);
  });
  it.each<JsonValue>([null, { value: null }, [null]])(
    "rejects null values (%j)",
    (value) => {
      expect(() => encodeStyled("q", value, BRACKETS)).toThrow(
        InvalidArguments,
      );
    },
  );
  it.each([
    "",
    "[]",
    "a[b]",
    "a]b",
    "0",
    "01",
    "-1",
    "0.5",
    "1e2",
    "0x1",
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "\ud800",
  ])("rejects ambiguous names and object segments (%j)", (key) => {
    expect(isBracketSegment(key)).toBe(false);
    expect(() => encodeStyled(key, "secret", BRACKETS)).toThrow(
      InvalidArguments,
    );
    if (!Number.isFinite(Number(key)) || key === "")
      expect(() =>
        encodeStyled("q", Object.fromEntries([[key, "secret"]]), BRACKETS),
      ).toThrow(InvalidArguments);
  });
  it.each(["q", "x y", "Café", "状态", "%5B", "foo.bar", "a_1", "$schema"])(
    "retains literal safe object segments (%s)",
    (key) => {
      expect(isBracketSegment(key)).toBe(true);
      expect(encodeStyled("q", { [key]: "ok" }, BRACKETS)).toEqual([
        [`q[${key}]`, "ok"],
      ]);
    },
  );
  it("preserves numeric object keys and omits empty collection leaves", () => {
    expect(
      encodeStyled("metadata", { "123": "value", "01": "zero" }, BRACKETS),
    ).toEqual([
      ["metadata[123]", "value"],
      ["metadata[01]", "zero"],
    ]);
    const emptyValues: JsonValue[] = [
      {},
      [],
      { nested: {} },
      { nested: [] },
      [[]],
      [{}],
    ];
    for (const value of emptyValues)
      expect(encodeStyled("q", value, BRACKETS)).toEqual([]);
    expect(encodeStyled("q", { empty: [], keep: false }, BRACKETS)).toEqual([
      ["q[keep]", "false"],
    ]);
  });
  it("treats percent signs as literal data rather than decoding another bracket layer", () => {
    expect(wireNamespace("filter%5Bunsafe%5D")).toBe("filter%5Bunsafe%5D");
    expect(wireNamespace("filter[unsafe]")).toBe("filter");
    expect(wire(encodeStyled("filter%5Bunsafe%5D", "ok", BRACKETS))).toBe(
      "filter%255Bunsafe%255D=ok",
    );
  });
  it.each(["\ud800", "\udc00"])(
    "rejects malformed Unicode in values without exposing it (%j)",
    (value) => {
      expect(() => encodeStyled("q", { value }, BRACKETS)).toThrow(
        InvalidArguments,
      );
    },
  );
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite JSON numbers (%j)",
    (value) => {
      expect(() => encodeStyled("q", value, BRACKETS)).toThrow(
        InvalidArguments,
      );
      expect(() => encodeStyled("q", { value }, BRACKETS)).toThrow(
        InvalidArguments,
      );
    },
  );
  it("rejects cyclic objects and arrays while permitting shared references", () => {
    const object: JsonObject = {};
    object.self = object;
    const array: JsonValue[] = [];
    array.push(array);
    expect(() => encodeStyled("q", object, BRACKETS)).toThrow("cyclic");
    expect(() => encodeStyled("q", array, BRACKETS)).toThrow("cyclic");
  });
  it("rejects sparse arrays and array properties which are not indexes", () => {
    const sparse: JsonValue[] = [];
    sparse.length = 3;
    sparse[1] = "value";
    expect(() => encodeStyled("q", sparse, BRACKETS)).toThrow("sparse");
    expect(() =>
      encodeStyled(
        "q",
        Object.assign(["value"], { extra: "secret" }),
        BRACKETS,
      ),
    ).toThrow(InvalidArguments);
  });
  it("rejects accessors without invoking them and rejects hidden or symbol properties", () => {
    let accessed = false;
    const accessor: JsonObject = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        accessed = true;
        return "private-value";
      },
    });
    const hidden: JsonObject = {};
    Object.defineProperty(hidden, "secret", { value: "private-value" });
    const symbolic: JsonObject = {};
    Object.defineProperty(symbolic, Symbol("secret"), {
      value: "private-value",
    });
    for (const value of [accessor, hidden, symbolic])
      expect(() => encodeStyled("q", value, BRACKETS)).toThrow(
        InvalidArguments,
      );
    expect(accessed).toBe(false);
  });
  it.each<unknown>([
    undefined,
    1n,
    Symbol("secret"),
    () => "secret",
    new Date(),
    new Set(["secret"]),
  ])(
    "rejects non-JSON JavaScript values at the pure boundary (%s)",
    (value) => {
      expect(() => {
        // @ts-expect-error The runtime boundary must reject callers bypassing the JsonValue type.
        encodeStyled("q", value, BRACKETS);
      }).toThrow(InvalidArguments);
    },
  );
  it("bounds traversal depth before pushing deeper child frames", () => {
    let value: JsonValue = "leaf";
    for (let i = 0; i < MAX_BRACKET_DEPTH; i++) value = { child: value };
    expect(encodeStyled("q", value, BRACKETS)).toHaveLength(1);
    expect(() => encodeStyled("q", { child: value }, BRACKETS)).toThrow(
      "depth",
    );
  });
  it("accepts the pair boundary and stops oversized arrays before encoding their values", () => {
    expect(
      encodeStyled(
        "q",
        Array.from({ length: MAX_BRACKET_PAIRS }, () => 0),
        BRACKETS,
      ),
    ).toHaveLength(MAX_BRACKET_PAIRS);
    let encoded = 0;
    expect(() =>
      encodeStyled(
        "q",
        Array.from({ length: MAX_BRACKET_PAIRS + 1 }, () => 0),
        BRACKETS,
        (text) => {
          encoded++;
          return text;
        },
      ),
    ).toThrow("pair count");
    expect(encoded).toBe(0);
  });
  it("bounds aggregate leaves across separate branches", () => {
    const value = {
      a: Array.from({ length: MAX_BRACKET_PAIRS / 2 }, () => 0),
      b: Array.from({ length: MAX_BRACKET_PAIRS / 2 }, () => 0),
    };
    expect(encodeStyled("q", value, BRACKETS)).toHaveLength(MAX_BRACKET_PAIRS);
    expect(() => encodeStyled("q", { ...value, extra: 0 }, BRACKETS)).toThrow(
      "pair count",
    );
  });
  it.each([encodeParameter, formEncode])(
    "counts escaped names, equals and separators in the encoded byte budget",
    (encode) => {
      const name = "q&";
      const remaining = MAX_BRACKET_BYTES - Buffer.byteLength(encode(name)) - 1;
      expect(
        wire(
          encodeStyled(name, "a".repeat(remaining), BRACKETS, encode),
          encode,
        ),
      ).toHaveLength(MAX_BRACKET_BYTES);
      expect(() =>
        encodeStyled(name, "a".repeat(remaining + 1), BRACKETS, encode),
      ).toThrow("byte count");
    },
  );
  it("bounds escaped multibyte values using encoded bytes rather than character count", () => {
    const budget = MAX_BRACKET_BYTES - 2;
    const value = "é".repeat(Math.floor(budget / 6)) + "a".repeat(budget % 6);
    expect(wire(encodeStyled("q", value, BRACKETS))).toHaveLength(
      MAX_BRACKET_BYTES,
    );
    expect(() => encodeStyled("q", `${value}a`, BRACKETS)).toThrow(
      "byte count",
    );
  });
  it("reports failures without including parameter names or values", () => {
    try {
      encodeStyled("private-name", { "private-property": null }, BRACKETS);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArguments);
      expect(JSON.stringify(error)).not.toContain("private-name");
      expect(JSON.stringify(error)).not.toContain("private-property");
      return;
    }
    throw new Error("Expected a typed serialization failure.");
  });
});
