import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  compileOpenApi,
  HttpApi,
  inspectCatalog,
  makeApiClient,
} from "effect-openapi-mcp";
import type { OperationDescriptor } from "effect-openapi-mcp";
import type { OperationArguments } from "../../src/schema.ts";

export const profileNames = [
  "echo",
  "inventory",
  "cloudflare-full",
  "cloudflare-filtered",
] as const;
export type Profile = (typeof profileNames)[number];
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const echo = {
  openapi: "3.2.1",
  servers: [{ url: "https://mock.invalid/v1" }],
  paths: {
    "/message": {
      get: {
        operationId: "echo_message",
        summary: "Echo a short message and count without external API calls.",
        parameters: [
          {
            name: "message",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 64 },
          },
          {
            name: "count",
            in: "query",
            required: true,
            schema: { type: "integer", minimum: 1, maximum: 10 },
          },
        ],
        responses: { "200": { content: { "application/json": {} } } },
      },
    },
    "/text": {
      query: {
        operationId: "echo_text",
        summary: "Echo Unicode text exactly without external API calls.",
        requestBody: {
          required: true,
          content: {
            "text/plain": {
              schema: { type: "string", minLength: 1, maxLength: 64 },
            },
          },
        },
        responses: { "200": { content: { "text/plain": {} } } },
      },
    },
  },
};

export const loadProfile = (profile: Profile) => {
  const stored =
    profile === "echo"
      ? Buffer.from(JSON.stringify(echo))
      : readFileSync(
          new URL(
            profile === "inventory"
              ? "../../fixtures/client-evaluation/inventory.openapi.json"
              : "../../fixtures/cloudflare.json.gz",
            import.meta.url,
          ),
        );
  const source = profile.startsWith("cloudflare") ? gunzipSync(stored) : stored;
  const filters =
    profile === "cloudflare-filtered"
      ? { methods: ["get"] as const, tags: ["Zone", "DNS Records for a Zone"] }
      : {};
  const catalog = compileOpenApi(JSON.parse(source.toString()), {
    ...filters,
    baseUrl: new URL("https://mock.invalid/v1/"),
    credentials: Object.fromEntries(
      ["api_email", "api_key", "api_token", "user_service_key"].map((name) => [
        name,
        Redacted.make("dummy-evaluation-only"),
      ]),
    ),
  });
  return {
    catalog,
    sourceHash: hash(source),
    storedHash: hash(stored),
    filters,
  };
};

export const profileMetadata = (profile: Profile) =>
  Effect.gen(function* () {
    const loaded = loadProfile(profile);
    const report = yield* inspectCatalog(loaded.catalog);
    return {
      profile,
      sourceHash: loaded.sourceHash,
      storedHash: loaded.storedHash,
      filters: loaded.filters,
      toolCount: report.tools.length,
      catalogHash: hash(JSON.stringify(report.tools)),
      unsupportedCount: report.unsupported.length,
      filteredCount: report.filtered.length,
    };
  });

export const sanitize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|cookie|token|access_token|refresh_token|secret|password|api.?key)$/i.test(
          key,
        )
          ? "[redacted]"
          : sanitize(item),
      ]),
    );
  return value;
};

export const mockApi = (profile: Profile, journal?: string) => {
  let nextId = 3;
  const items = new Map([
    ["it_1", { id: "it_1", label: "Café + 😀", state: "ACTIVE" }],
    ["it_2", { id: "it_2", label: "Spare cable", state: "ARCHIVED" }],
  ]);
  const record = (entry: object) =>
    Effect.sync(() => {
      if (journal)
        appendFileSync(
          journal,
          JSON.stringify(
            sanitize({ timestamp: new Date().toISOString(), ...entry }),
          ) + "\n",
        );
    });
  // This is the only HTTP service. It constructs in-memory Responses for EVERY
  // operation; no FetchHttpClient, socket, public endpoint or fallback exists.
  const createHttp = (selected: { name: string; args: OperationArguments }) =>
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const url = new URL(request.url);
        let response: Response;
        if (profile === "echo")
          response = url.pathname.endsWith("/message")
            ? Response.json({
                message: url.searchParams.get("message"),
                count: Number(url.searchParams.get("count")),
              })
            : new Response(
                request.body._tag === "Uint8Array" ? request.body.body : null,
                { headers: { "Content-Type": "text/plain; charset=utf-8" } },
              );
        else if (profile === "inventory") {
          const id = url.pathname.split("/").at(-1) ?? "";
          const body = selected?.args.body;
          if (url.pathname.endsWith("/slow")) {
            yield* Effect.sleep("30 seconds").pipe(
              Effect.onInterrupt(() =>
                record({ event: "cancelled", tool: selected?.name }),
              ),
            );
            response = Response.json({ mock: true, finished: true });
          } else if (url.pathname.endsWith("/unavailable"))
            response = Response.json(
              { private_upstream_body: "DO_NOT_EXPOSE" },
              { status: 503 },
            );
          else if (request.method === "GET" && url.pathname.endsWith("/items"))
            response = Response.json({
              items: [...items.values()].slice(
                0,
                Number(url.searchParams.get("limit") ?? 20),
              ),
            });
          else if (url.pathname.endsWith("/search"))
            response = Response.json({
              items: [...items.values()].filter((item) =>
                item.label.includes(
                  String((body as { term?: string })?.term ?? ""),
                ),
              ),
            });
          else if (request.method === "POST") {
            const item = {
              ...(body as { label: string; state: string }),
              id: `it_${nextId++}`,
            };
            items.set(item.id, item);
            response = Response.json(item);
          } else if (request.method === "DELETE") {
            items.delete(id);
            response = new Response(null, { status: 204 });
          } else if (request.method === "PATCH" && items.has(id)) {
            const item = { ...(body as { label: string; state: string }), id };
            items.set(id, item);
            response = Response.json(item);
          } else
            response = items.has(id)
              ? Response.json(items.get(id))
              : Response.json(
                  { private_upstream_body: "DO_NOT_EXPOSE" },
                  { status: 404 },
                );
        } else {
          const result =
            selected?.name === "zones-get"
              ? [
                  {
                    id: "00000000000000000000000000000001",
                    name: "example.test",
                    status: "active",
                  },
                ]
              : selected?.name === "dns-records-for-a-zone-list-dns-records"
                ? [
                    {
                      id: "00000000000000000000000000000002",
                      type: "A",
                      name: "www.example.test",
                      content: "192.0.2.1",
                    },
                  ]
                : [];
          response = Response.json({
            success: true,
            errors: [],
            messages: [],
            result,
            mock: true,
            operation: selected?.name,
          });
        }
        return HttpClientResponse.fromWeb(request, response);
      }),
    );
  return Layer.succeed(HttpApi, {
    execute: Effect.fn("evaluation.mock")(function* (
      operation: OperationDescriptor,
      args: OperationArguments,
    ) {
      const api = makeApiClient(
        createHttp({ name: operation.name, args }),
        45_000,
      );
      yield* record({
        event: "dispatch",
        tool: operation.name,
        arguments: args,
        mutation: !operation.annotations.readOnlyHint,
      });
      const value = yield* api
        .execute(operation, args)
        .pipe(
          Effect.tapError((error) =>
            record({ event: "error", tool: operation.name, error }),
          ),
        );
      yield* record({ event: "result", tool: operation.name, result: value });
      return value;
    }),
  });
};
