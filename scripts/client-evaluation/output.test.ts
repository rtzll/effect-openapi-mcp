import { PassThrough } from "node:stream";
import { expect, it } from "vite-plus/test";
import { collectUtf8 } from "./output.ts";
it("preserves Unicode split across every byte boundary in client output", () => {
  const stream = new PassThrough();
  let captured = "";
  collectUtf8(stream, (text) => {
    captured += text;
  });
  const expected = '\uFEFF{"text":"Café + 😀\\r\\n"}\r\n';
  for (const byte of Buffer.from(expected)) stream.write(Buffer.from([byte]));
  stream.end();
  expect(captured).toBe(expected);
});
