import type { Readable } from "node:stream";
// Decode across arbitrary pipe chunks, including split BOM/astral UTF-8 bytes.
export const collectUtf8 = (
  stream: Readable,
  append: (text: string) => void,
) => {
  stream.setEncoding("utf8");
  stream.on("data", (text: string) => append(text));
};
