import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Ref } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpServer,
} from "effect/http";
import { NetAddress } from "effect/net";
import { InvalidArguments } from "./api-errors.ts";
import { HttpApi, makeApiClient } from "./api-client.ts";
import { loadOperationCatalog } from "./catalog.ts";
import { createMcpServer } from "./server.ts";
import { API_RESPONSES } from "./test-fixtures.ts";
import { generatedTools } from "./tools.ts";

const OWNER = {
  type: "object",
  additionalProperties: false,
  required: ["name", "enabled"],
  properties: {
    name: { type: "string", minLength: 2 },
    enabled: { type: "boolean" },
  },
};
const FILTER = {
  type: "object",
  additionalProperties: false,
  required: ["owner", "items"],
  properties: {
    owner: OWNER,
    items: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "quantity"],
        properties: {
          code: { type: "string", minLength: 2 },
          quantity: { type: "integer", minimum: 1 },
        },
      },
    },
  },
};
const TAGS = {
  type: "array",
  minItems: 1,
  maxItems: 3,
  items: { type: "string", minLength: 1 },
};
const CREATED = {
  anyOf: [
    { type: "integer", minimum: 1 },
    {
      type: "object",
      additionalProperties: false,
      required: ["gt"],
      properties: { gt: { type: "integer", minimum: 1 } },
    },
  ],
};
const COLLISION_FILTER = {
  type: "object",
  additionalProperties: false,
  required: ["owner"],
  properties: {
    owner: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", minLength: 1 } },
    },
  },
};
const DEEP_OBJECT = { style: "deepObject", explode: true };
const parameters = Object.entries({
  filter: FILTER,
  tags: TAGS,
  created: CREATED,
}).map(([name, schema]) => ({
  name,
  in: "query",
  required: true,
  ...DEEP_OBJECT,
  schema,
}));
const profileSpec = (openapi: string) => ({
  openapi,
  info: { title: "Generic bracket serialization", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  components: {
    securitySchemes: {
      QueryKey: { type: "apiKey", in: "query", name: "filter[owner]" },
    },
  },
  paths: {
    "/health": { get: { operationId: "health", responses: API_RESPONSES } },
    "/query": {
      get: {
        operationId: "profile_query",
        parameters,
        responses: API_RESPONSES,
      },
    },
    "/forms": {
      post: {
        operationId: "profile_form",
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["filter", "tags", "created"],
                properties: { filter: FILTER, tags: TAGS, created: CREATED },
              },
              encoding: {
                filter: DEEP_OBJECT,
                tags: DEEP_OBJECT,
                created: DEEP_OBJECT,
              },
            },
          },
        },
        responses: API_RESPONSES,
      },
    },
    "/query-collision": {
      get: {
        operationId: "query_collision",
        parameters: [
          {
            name: "filter",
            in: "query",
            required: true,
            ...DEEP_OBJECT,
            schema: COLLISION_FILTER,
          },
          {
            name: "filter[owner]",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: API_RESPONSES,
      },
    },
    "/auth-collision": {
      get: {
        operationId: "auth_collision",
        security: [{ QueryKey: [] }],
        parameters: [
          {
            name: "filter",
            in: "query",
            required: true,
            ...DEEP_OBJECT,
            schema: COLLISION_FILTER,
          },
        ],
        responses: API_RESPONSES,
      },
    },
    "/form-collision": {
      post: {
        operationId: "form_collision",
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["filter", "filter[owner]"],
                properties: {
                  filter: COLLISION_FILTER,
                  "filter[owner]": { type: "string" },
                },
              },
              encoding: { filter: DEEP_OBJECT },
            },
          },
        },
        responses: API_RESPONSES,
      },
    },
  },
});
const VALUE = {
  filter: {
    owner: { name: "A B+C&=é", enabled: false },
    items: [{ code: "X/Y", quantity: 2 }],
  },
  tags: ["one two", "a,b"],
  created: 7,
};
const QUERY_WIRE =
  "filter%5Bowner%5D%5Bname%5D=A%20B%2BC%26%3D%C3%A9&filter%5Bowner%5D%5Benabled%5D=false&filter%5Bitems%5D%5B0%5D%5Bcode%5D=X%2FY&filter%5Bitems%5D%5B0%5D%5Bquantity%5D=2&tags%5B0%5D=one%20two&tags%5B1%5D=a%2Cb&created=7";
const FORM_WIRE =
  "filter%5Bowner%5D%5Bname%5D=A+B%2BC%26%3D%C3%A9&filter%5Bowner%5D%5Benabled%5D=false&filter%5Bitems%5D%5B0%5D%5Bcode%5D=X%2FY&filter%5Bitems%5D%5B0%5D%5Bquantity%5D=2&tags%5B0%5D=one+two&tags%5B1%5D=a%2Cb&created=7";

it.live.each(["3.0.4", "3.1.2", "3.2.1"])(
  "discovers and executes default bracket profiles with native constraints and safe namespaces (%s)",
  (openapi) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "openapi-mcp-profile-wire-",
      });
      const location = join(directory, "profile.json");
      yield* fs.writeFileString(location, JSON.stringify(profileSpec(openapi)));
      const credentials = { QueryKey: Redacted.make("private-profile-key") };
      const strictCatalog = yield* loadOperationCatalog(location, {
        credentials,
        parameterProfile: "spec",
      });
      expect(
        strictCatalog.operations.map((operation) => operation.name),
      ).toEqual(["health"]);
      expect(strictCatalog.unsupported).toHaveLength(5);
      expect(
        strictCatalog.unsupported.map((operation) => operation.path),
      ).toContain("/query");
      expect(
        strictCatalog.unsupported.map((operation) => operation.path),
      ).toContain("/forms");
      const catalog = yield* loadOperationCatalog(location, {
        credentials,
      });
      expect(catalog.unsupported).toEqual([]);
      expect(catalog.operations).toHaveLength(6);
      const requests = yield* Ref.make<
        Array<{
          method: string;
          url: string;
          body: string;
          contentType: string | undefined;
        }>
      >([]);
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          const body =
            request.body._tag === "Uint8Array"
              ? new TextDecoder().decode(request.body.body)
              : "";
          yield* Ref.update(requests, (requests) => [
            ...requests,
            {
              method: request.method,
              url: request.url,
              body,
              contentType: request.headers["content-type"],
            },
          ]);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ accepted: true }),
          );
        }),
      );
      const api = makeApiClient(http);
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const endpoint = new URL(
          "/mcp",
          NetAddress.formatUrlUnsafe(server.address),
        );
        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Client(
                { name: "profile-wire-test", version: "1.0.0" },
                { versionNegotiation: { mode: { pin: "2026-07-28" } } },
              ),
          ),
          (client) =>
            Effect.tryPromise(() => client.close()).pipe(Effect.orDie),
        );
        yield* Effect.tryPromise(() =>
          client.connect(new StreamableHTTPClientTransport(endpoint)),
        );
        const listing = yield* Effect.tryPromise(() => client.listTools());
        expect(listing.tools.map((tool) => tool.name).sort()).toEqual([
          "auth_collision",
          "form_collision",
          "health",
          "profile_form",
          "profile_query",
          "query_collision",
        ]);
        const queryTool = listing.tools.find(
          (tool) => tool.name === "profile_query",
        );
        const formTool = listing.tools.find(
          (tool) => tool.name === "profile_form",
        );
        expect(queryTool?.inputSchema).toHaveProperty(
          "properties.query.properties.filter.properties.owner.properties.name.minLength",
          2,
        );
        expect(queryTool?.inputSchema).toHaveProperty(
          "properties.query.properties.filter.properties.items.items.properties.quantity.minimum",
          1,
        );
        expect(formTool?.inputSchema).toHaveProperty(
          "properties.body.properties.filter.properties.owner.properties.name.minLength",
          2,
        );
        expect(JSON.stringify(listing)).not.toContain("private-profile-key");
        for (const [name, arguments_] of [
          ["profile_query", { query: VALUE }],
          ["profile_form", { body: VALUE }],
        ] as const) {
          const result = yield* Effect.tryPromise(() =>
            client.callTool({ name, arguments: arguments_ }),
          );
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toEqual({ accepted: true });
        }
        expect(yield* Ref.get(requests)).toEqual([
          {
            method: "GET",
            url: `https://api.example.com/v1/query?${QUERY_WIRE}`,
            body: "",
            contentType: undefined,
          },
          {
            method: "POST",
            url: "https://api.example.com/v1/forms",
            body: FORM_WIRE,
            contentType: "application/x-www-form-urlencoded",
          },
        ]);
        const unionResult = yield* Effect.tryPromise(() =>
          client.callTool({
            name: "profile_query",
            arguments: { query: { ...VALUE, created: { gt: 2 } } },
          }),
        );
        expect(unionResult.isError).not.toBe(true);
        expect((yield* Ref.get(requests))[2]?.url).toBe(
          `https://api.example.com/v1/query?${QUERY_WIRE.replace("created=7", "created%5Bgt%5D=2")}`,
        );
        for (const [name, arguments_] of [
          [
            "profile_query",
            {
              query: {
                ...VALUE,
                filter: {
                  ...VALUE.filter,
                  owner: { name: "X", enabled: false },
                },
              },
            },
          ],
          [
            "profile_query",
            {
              query: {
                ...VALUE,
                filter: {
                  ...VALUE.filter,
                  items: [{ code: "XY", quantity: 0 }],
                },
              },
            },
          ],
          [
            "profile_form",
            {
              body: {
                ...VALUE,
                filter: {
                  ...VALUE.filter,
                  items: [{ code: "XY", quantity: 0 }],
                },
              },
            },
          ],
        ] as const) {
          const result = yield* Effect.tryPromise(() =>
            client.callTool({ name, arguments: arguments_ }),
          );
          expect(result.isError).toBe(true);
        }
        expect(yield* Ref.get(requests)).toHaveLength(3);
        for (const [name, arguments_] of [
          [
            "query_collision",
            {
              query: {
                filter: { owner: { id: "x" } },
                "filter[owner]": "shadow",
              },
            },
          ],
          ["auth_collision", { query: { filter: { owner: { id: "x" } } } }],
          [
            "form_collision",
            {
              body: {
                filter: { owner: { id: "x" } },
                "filter[owner]": "shadow",
              },
            },
          ],
        ] as const) {
          const result = yield* Effect.tryPromise(() =>
            client.callTool({ name, arguments: arguments_ }),
          );
          expect(result.isError).toBe(true);
          const content = result.content.find(
            (content) => content.type === "text",
          );
          if (content?.type !== "text") {
            return yield* Effect.die(
              "Expected a typed tool error as MCP text content.",
            );
          }
          const operation = catalog.operations.find(
            (operation) => operation.name === name,
          );
          if (operation === undefined) {
            return yield* Effect.die(
              "Expected a catalog operation for the tool.",
            );
          }
          const error = yield* api
            .execute(operation, arguments_)
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(InvalidArguments);
          expect(content.text).toBe(error.message);
          expect(JSON.stringify(result)).not.toContain("private-profile-key");
          expect(yield* Ref.get(requests)).toHaveLength(3);
        }
      }).pipe(
        Effect.provide(
          createMcpServer(generatedTools(catalog), {
            port: 0,
            logAddress: false,
          }).pipe(Layer.provide(Layer.succeed(HttpApi, api))),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide([NodeFileSystem.layer, FetchHttpClient.layer]),
    ),
);
