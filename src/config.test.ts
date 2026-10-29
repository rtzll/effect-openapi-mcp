import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { AdapterConfig, ConfigurationError } from "./config.ts";

const readConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  AdapterConfig.pipe(
    Effect.provide(
      AdapterConfig.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              preserveEmptyStrings: true,
              env: Object.fromEntries(
                Object.entries(environment).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
            }),
          ),
        ),
      ),
    ),
  );

const SPEC = { MCP_OPENAPI_SPEC: "/tmp/inventory.json" };
describe("Generic configuration", () => {
  it.effect("requires an explicit spec and assumes no API or credentials", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(readConfiguration({}));
      expect(failure).toBeInstanceOf(ConfigurationError);
      expect(failure.message).toContain("MCP_OPENAPI_SPEC");
      const configuration = yield* readConfiguration(SPEC);
      expect(configuration).toMatchObject({
        openApiSpec: SPEC.MCP_OPENAPI_SPEC,
        credentials: {},
        methods: [],
        tags: [],
        port: 3000,
        timeoutMs: 10_000,
        specTimeoutMs: 10_000,
        referencesMode: "none",
        maxReferenceDocuments: 128,
        maxReferenceDepth: 64,
        parameterProfile: "brackets-indexed",
        maxSpecBytes: 33554432,
        maxResponseBytes: 8388608,
        maxRequestBytes: 8388608,
      });
      expect(configuration.baseUrl).toEqual(Option.none());
    }),
  );
  it.effect("accepts spec URLs, a target override, and generic filters", () =>
    Effect.gen(function* () {
      const configuration = yield* readConfiguration({
        MCP_OPENAPI_SPEC: "https://inventory.example.com/openapi.json",
        MCP_API_BASE_URL: "http://127.0.0.1:9000/v2",
        MCP_METHODS: '["get","post","query"]',
        MCP_TAGS: '["inventory"]',
        PORT: "4000",
        MCP_TIMEOUT_MS: "20000",
        MCP_SPEC_TIMEOUT_MS: "25000",
        MCP_MAX_SPEC_BYTES: "100000",
        MCP_MAX_RESPONSE_BYTES: "200000",
        MCP_MAX_REQUEST_BYTES: "300000",
        MCP_REFERENCES_MODE: "same-origin",
        MCP_MAX_REFERENCE_DOCUMENTS: "200",
        MCP_MAX_REFERENCE_DEPTH: "100",
        MCP_PARAMETER_PROFILE: "brackets-indexed",
      });
      expect(Option.getOrThrow(configuration.baseUrl).href).toBe(
        "http://127.0.0.1:9000/v2/",
      );
      expect(configuration).toMatchObject({
        methods: ["get", "post", "query"],
        tags: ["inventory"],
        port: 4000,
        timeoutMs: 20000,
        specTimeoutMs: 25000,
        maxSpecBytes: 100000,
        maxResponseBytes: 200000,
        maxRequestBytes: 300000,
        referencesMode: "same-origin",
        maxReferenceDocuments: 200,
        maxReferenceDepth: 100,
        parameterProfile: "brackets-indexed",
      });
    }),
  );
  it.effect("reads credentials by scheme name and keeps them redacted", () =>
    Effect.gen(function* () {
      const configuration = yield* readConfiguration({
        ...SPEC,
        MCP_CREDENTIALS: '{"ApiKey":"private-key","Bearer":"private-token"}',
      });
      expect(configuration.credentials.ApiKey).toEqual(
        Redacted.make("private-key"),
      );
      expect(JSON.stringify(configuration)).not.toContain("private-key");
      expect(JSON.stringify(configuration)).not.toContain("private-token");
    }),
  );
  it.effect("validates credentials without changing their values", () =>
    Effect.gen(function* () {
      const configuration = yield* readConfiguration({
        ...SPEC,
        MCP_CREDENTIALS: '{"ApiKey":" private-key "}',
      });
      expect(configuration.credentials.ApiKey).toEqual(
        Redacted.make(" private-key "),
      );
    }),
  );
  it.effect.each([
    { MCP_OPENAPI_SPEC: "" },
    { MCP_OPENAPI_SPEC: " " },
    { MCP_METHODS: '["unknown"]' },
    { MCP_TRANSPORT: "sse" },
    { MCP_TAGS: '[""]' },
    { MCP_CREDENTIALS: '{"ApiKey":""}' },
    { MCP_CREDENTIALS: '{"ApiKey":" "}' },
    { MCP_CREDENTIALS: '{"ApiKey":"private-key\\n"}' },
    { MCP_CREDENTIALS: '{"ApiKey":"private\\nkey"}' },
    { MCP_CREDENTIALS: "not-json" },
    { PORT: "0" },
    { PORT: "65536" },
    { PORT: "1.5" },
    { MCP_TIMEOUT_MS: "0" },
    { MCP_SPEC_TIMEOUT_MS: "0" },
    { MCP_SPEC_TIMEOUT_MS: "2147483648" },
    { MCP_SPEC_TIMEOUT_MS: "1.5" },
    { MCP_REFERENCES_MODE: "any" },
    { MCP_MAX_REFERENCE_DOCUMENTS: "0" },
    { MCP_MAX_REFERENCE_DOCUMENTS: "4097" },
    { MCP_MAX_REFERENCE_DEPTH: "0" },
    { MCP_MAX_REFERENCE_DEPTH: "257" },
    { MCP_MAX_REFERENCE_DEPTH: "1.5" },
    { MCP_PARAMETER_PROFILE: "brackets" },
    { MCP_MAX_SPEC_BYTES: "0" },
    { MCP_MAX_RESPONSE_BYTES: "1.5" },
    { MCP_MAX_REQUEST_BYTES: "1073741825" },
  ])("rejects invalid configuration", (environment) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        readConfiguration({ ...SPEC, ...environment }),
      );
      expect(failure).toBeInstanceOf(ConfigurationError);
      expect(failure.message).toContain("Invalid configuration");
      expect(failure.message).toContain("Expected");
    }),
  );
  it.effect.each([
    "http://api.example.com/",
    "https://user:private-key@api.example.com/",
    "https://api.example.com/?key=private-key",
    "https://api.example.com/#private-key",
    "not-a-url",
  ])("rejects unsafe target URLs without exposing credentials", (url) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        readConfiguration({ ...SPEC, MCP_API_BASE_URL: url }),
      );
      expect(failure.message).toContain("MCP_API_BASE_URL");
      expect(failure.message).toContain(
        "without credentials, query or fragment",
      );
      expect(JSON.stringify(failure)).not.toContain("private-key");
    }),
  );
});

it.effect("configures fixed and optional per-call request headers", () =>
  Effect.gen(function* () {
    const config = yield* readConfiguration({
      ...SPEC,
      MCP_REQUEST_HEADERS:
        '{"Stripe-Version":"2026-09-30.endive","Stripe-Account":"acct_fixture"}',
      MCP_TOOL_HEADERS: '["Idempotency-Key"]',
    });
    expect(config.toolHeaders).toEqual(["Idempotency-Key"]);
    expect(
      Redacted.value(
        config.requestHeaders?.["Stripe-Version"] ?? Redacted.make("missing"),
      ),
    ).toBe("2026-09-30.endive");
    for (const headers of [
      '{"Authorization":"secret"}',
      '{"Host":"evil"}',
      '{"X-Test":" leading"}',
      '{"X-Test":"a\\r\\nb"}',
    ]) {
      const failure = yield* Effect.flip(
        readConfiguration({ ...SPEC, MCP_REQUEST_HEADERS: headers }),
      );
      expect(failure).toBeInstanceOf(ConfigurationError);
      expect(failure.message).not.toContain("secret");
    }
    for (const headers of [
      '["Content-Type"]',
      '["Idempotency-Key","idempotency-key"]',
    ])
      expect(
        yield* Effect.flip(
          readConfiguration({ ...SPEC, MCP_TOOL_HEADERS: headers }),
        ),
      ).toBeInstanceOf(ConfigurationError);
  }),
);
