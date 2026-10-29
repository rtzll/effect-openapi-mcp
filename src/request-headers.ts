// Authentication and HTTP framing remain owned by the adapter/client.
export const isRequestHeaderName = (name: string): boolean =>
  /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) &&
  !/^(?:proxy-|sec-)/i.test(name) &&
  !new Set([
    "host",
    "authorization",
    "cookie",
    "connection",
    "content-length",
    "transfer-encoding",
    "content-type",
    "accept",
    "trailer",
    "te",
    "upgrade",
    "keep-alive",
  ]).has(name.toLowerCase());

export const isRequestHeaderValue = (value: string): boolean =>
  value.length > 0 && value.trim() === value && /^[\x20-\x7e]+$/.test(value);
