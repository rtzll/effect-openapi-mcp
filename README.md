# Effect OpenAPI MCP

**Expose an API as MCP tools using its OpenAPI specification.** Supply the spec,
API target and credentials; the adapter generates tools, validates arguments and
calls the API. No hand-written tool per endpoint is needed.

Use it as a **stdio or local HTTP server**, or embed its **Effect 4 library**.
It supports a defined subset of OpenAPI **3.0 / 3.1 / 3.2**, in JSON or YAML.

[Quickstart](#quickstart) · [Your API](#use-your-own-api) · [MCP clients](#connect-an-mcp-client) ·
[Library](#use-the-library) · [Configuration](#configuration) ·
[Compatibility](#compatibility-reference) · [Security](#security)

## Quickstart

From a source checkout, in the project directory containing `package.json`,
[install Vite+](https://viteplus.dev/guide/#install-vp-globally), open a new
terminal, then run:

```sh
vp install --frozen-lockfile
vp run demo
```

Vite+ selects Node from `.node-version`, pnpm from `package.json#packageManager`,
and the project toolchain from the lockfile. No separate Node or pnpm setup is
needed. The package requires Node 24.18+.

The demo builds the package, starts a local mock MCP server, calls its tools,
checks invalid input, then shuts down. It needs **no `.env`, credentials or external
API**. Only tool/dependency installation needs network access or populated caches.

## Use your own API

Copy `.env.example` to `.env`, then replace its values. For example:

```dotenv
MCP_OPENAPI_SPEC=/absolute/path/to/your/openapi.yaml
MCP_API_BASE_URL=https://api.example.com/v1/
MCP_CREDENTIALS='{"ApiKeyAuth":"replace-with-your-api-key"}'
MCP_METHODS='["get"]'
MCP_TRANSPORT=http
```

`ApiKeyAuth` must match a security-scheme name in **your spec**; use `{}` for an
anonymous API. The target override is optional when the spec declares the right
server. The specification can also be an HTTPS URL.

Inspect before serving:

```sh
vp run start inspect
vp run start check --strict
vp run start
```

`inspect` lists tools and exclusions without calling the API. `check` requires a
nonempty, exportable catalog; `--strict` also rejects unsupported operations.
Intentional method/tag filters are allowed. The HTTP endpoint defaults to
**`http://127.0.0.1:3000/mcp`**. Restart after changing the spec or configuration.

**Without filters, all supported operations are exposed, including writes.** The
example above limits discovery and execution to GET operations. Use credentials
with only the permissions you need. The bundled inventory spec is an example
contract; it requires your own matching API for real requests.

Add `--json` to `inspect` for machine-readable output. To avoid task-runner output,
use `vp exec node --env-file=.env src/cli.ts inspect --json`.

`vp run start --help` lists CLI options. **`vp run start check` checks your API spec;
`vp run check` checks this project's code.**

## Connect an MCP client

### Try the offline fixture in Claude Code

After the quickstart, print a ready-to-use configuration:

```sh
vp exec node scripts/client-config.ts
```

Merge the printed `mcpServers` entry into your Claude Code project's `.mcp.json`.
Open Claude Code there, run `/mcp`, and approve `openapi-fixture` when prompted.
Ask: **Use echo_message to echo “Café + 😀” with count 3.**
The tool should return `{"message":"Café + 😀","count":3}`.
The generator prints configuration only; it does not edit files or start a server.

### Connect your own API over stdio

Build the executable and get the selected Node path:

```sh
vp run build
vp exec node -p "process.execPath"
```

Set `MCP_TRANSPORT=stdio` in `.env`. In a client using `mcpServers` configuration,
replace these example paths with your actual absolute paths:

```json
{
  "mcpServers": {
    "my-api": {
      "command": "/absolute/path/to/node",
      "args": [
        "--env-file=/absolute/path/to/openapi-mcp/.env",
        "/absolute/path/to/openapi-mcp/dist/cli.js"
      ]
    }
  }
}
```

Other clients use the same executable and arguments in their own configuration
format. The client owns the process. Use absolute paths for the local spec too,
keep stdout protocol-only, and build before connecting. Adapter logs go to stderr.
Rebuild after source changes; regenerate fixture configuration if paths move.

**Troubleshooting:** missing `dist` means run `vp run build`; missing tools means
check `inspect`, credentials and filters. For oversized catalogs, narrow
`MCP_METHODS`/`MCP_TAGS` to fit your client's limits. HTTP clients can instead
connect to the running loopback endpoint above.

## Use the library

Import from `effect-openapi-mcp`. `compileOpenApi(document, options)` compiles an
assembled document without I/O; `loadOperationCatalog(location, options)` loads
and resolves a file/URL through Effect. Compose `HttpApi`, `generatedTools` and
HTTP/stdio server layers when embedding the adapter. Imports never start a server.

These complete examples build and run offline:

| Command after `vp run` | Demonstrates                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `example:library`      | [Validate arguments and substitute HTTP with a layer](examples/library-program.ts)    |
| `example:recovery`     | [Handle an actual HTTP 429 with explicit fallback data](examples/recovery-program.ts) |
| `example:cancellation` | [Interrupt a request and observe cleanup](examples/cancellation-program.ts)           |

Every `vp run check` type-checks all examples and runs their offline tests against
the built library.

To use the library in another application, create an installable tarball:

```sh
vp pm pack --pack-destination /tmp
```

Install the printed `.tgz` file with your application's package manager, keeping
its Effect dependencies aligned with `package.json`. The library and CLI ship
compiled JavaScript. Copy TypeScript examples and their imported helpers into
your application's source before running them with Node; Node does not strip
TypeScript inside `node_modules`.

`vp run test:package /absolute/path/to/the-printed-archive.tgz --online` checks
the public types, CLI and packaged examples in an independent fresh consumer.

## Configuration

`vp run start` loads `.env` if present. Direct Node runs need `--env-file` explicitly.
Method/tag filters are JSON arrays; both must match when set, and empty arrays
mean unrestricted. Credential values are raw keys/tokens (`username:password`
for Basic); OAuth token acquisition and refresh happen outside this adapter.
API targets and remote specs require HTTPS, except loopback HTTP; redirects are rejected.

| Variable                      | Default            | Purpose                                                        |
| ----------------------------- | ------------------ | -------------------------------------------------------------- |
| `MCP_OPENAPI_SPEC`            | Required           | OpenAPI JSON/YAML file or HTTPS URL                            |
| `MCP_API_BASE_URL`            | Spec's servers     | Optional target override                                       |
| `MCP_CREDENTIALS`             | `{}`               | JSON object of security-scheme names to secrets                |
| `MCP_TRANSPORT`               | `http`             | `http` or `stdio`                                              |
| `MCP_METHODS`                 | `[]`               | JSON array of lowercase HTTP methods to expose                 |
| `MCP_TAGS`                    | `[]`               | JSON array of operation tags to expose                         |
| `MCP_SPEC_TIMEOUT_MS`         | `10000`            | Specification read/download deadline                           |
| `MCP_REFERENCES_MODE`         | `none`             | External references: `none`, `local`, `same-origin`            |
| `MCP_MAX_REFERENCE_DOCUMENTS` | `128`              | Maximum root and referenced documents                          |
| `MCP_MAX_REFERENCE_DEPTH`     | `64`               | Maximum dereference chain length                               |
| `MCP_REQUEST_HEADERS`         | `{}`               | Fixed API request headers as a JSON object                     |
| `MCP_TOOL_HEADERS`            | `[]`               | Optional per-call header names exposed in tool inputs          |
| `MCP_PARAMETER_PROFILE`       | `brackets-indexed` | Use `spec` for strict portable deepObject encoding             |
| `MCP_TIMEOUT_MS`              | `10000`            | Upstream deadline, including reading the response body         |
| `MCP_MAX_SPEC_BYTES`          | `33554432`         | Total specification graph bytes                                |
| `MCP_MAX_RESPONSE_BYTES`      | `8388608`          | Maximum decoded upstream response bytes                        |
| `MCP_MAX_REQUEST_BYTES`       | `8388608`          | Maximum MCP HTTP input and encoded upstream request body bytes |
| `PORT`                        | `3000`             | Loopback HTTP port                                             |

External references default off. `local` confines them to the entry file's
canonical directory; `same-origin` confines them to its HTTPS/loopback origin.
They share the graph byte/deadline limits, never inherit API credentials and
cannot follow redirects. Relative local paths use the process working directory.

The default `brackets-indexed` profile serializes declared `deepObject` query/form
fields with indexed brackets, including nested arrays and objects. Other parameter
styles follow their declarations. This convention extends beyond OpenAPI's
portable flat-object rules; use `MCP_PARAMETER_PROFILE=spec` when an API requires
strict portable encoding. That mode excludes operations with unsupported shapes.

Indexed encoding preserves numeric map keys. Empty objects and arrays emit no
fields; use an empty string when the API requires an explicit clearing value.

Stripe's published spec works with the default profile. Use credentials named
`bearerAuth`. Leave `MCP_API_BASE_URL` unset: Stripe's file
operations use `files.stripe.com`, while most operations use `api.stripe.com`.

To pin Stripe's API version and optionally target a connected account:

```dotenv
MCP_REQUEST_HEADERS='{"Stripe-Version":"2026-09-30.endive","Stripe-Account":"acct_example"}'
MCP_TOOL_HEADERS='["Idempotency-Key"]'
```

Omit `Stripe-Account` when using your own account. Each tool then accepts an
optional `headers` object, for example `{"headers":{"Idempotency-Key":"order-123"}}`.
Use a distinct key for each logical write and reuse it only when repeating that
same write. Keep idempotency keys per call rather than setting a fixed default.
Per-call values override fixed defaults. Declared header schemas retain their
constraints; authentication and transport headers cannot be configured this way.
Fixed values are redacted in configuration and never included in tool schemas.

## Compatibility reference

| Area           | Supported scope / important limits                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents      | OpenAPI 3.0/3.1/3.2 JSON or one YAML 1.2 document; Swagger 2, duplicate keys, YAML aliases/custom tags and multiple documents are rejected                                      |
| Schemas        | Native Effect validation for supported constraints, compositions and recursive refs; unsupported constructs produce diagnostics rather than approximate validation              |
| HTTP           | GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS and OpenAPI 3.2 QUERY; JSON, supported form-urlencoded, multipart and ordinary UTF-8 text; YAML/PDF/octet-stream responses; no streaming |
| Authentication | Header/query API keys, bearer, Basic and supplied OAuth/OIDC tokens; missing/unsupported protected credentials omit the operation, never retry anonymously                      |
| MCP            | Tools over HTTP/stdio; `2026-07-28` and tested legacy revisions; no resources/prompts or retired separate SSE transport                                                         |
| Responses      | Full JSON/text content; response schemas are not validated; no automatic pagination or retries                                                                                  |

Tool arguments group locations as `path`, `query`, `headers` and `body`.
Valid `operationId` values become tool names; other names are normalized
predictably. Objects are returned directly as structured content; other results
use `{ "result": ... }`. Defaults/formats are annotations, not value injection
or additional format validation. Run `inspect` and `check --strict` to see which
operations can be exposed and why others are excluded.

Multipart file fields (for example `body.file`) take this JSON value:

```json
{
  "dataBase64": "AAH/gA==",
  "filename": "example.bin",
  "mediaType": "application/octet-stream"
}
```

Use canonical padded base64, a simple ASCII filename and a concrete media type.
Paths and URLs are not read. Other body fields keep their declared types.
Multipart support covers closed object schemas with top-level binary file fields;
unsupported encodings and file constraints produce diagnostics. The request byte
limit includes multipart headers and boundaries.

Declared `application/pdf` and `application/octet-stream` responses return
`{ "mimeType": "application/pdf", "dataBase64": "JVBERi0…" }` through both the
library and MCP structured content. Decode `dataBase64` to recover the original
bytes. `MCP_MAX_RESPONSE_BYTES` limits the received bytes before base64 expansion;
oversized or mismatched response types fail without returning partial data.

`application/yaml` responses return the original UTF-8 text, preserving comments,
line endings and YAML syntax. The library returns a string; MCP returns
`{ "result": "..." }`. The same response byte limit applies. YAML responses are
not parsed into objects.

Uploads to a presigned URL returned by an earlier API call require a separate
workflow. Generated tools use the specification's servers or the configured
base URL; they do not accept arbitrary destination URLs at runtime.

In a source checkout, `vp run compatibility` and `vp run benchmark` generate
local reports from the pinned fixture corpus. The benchmark measures the default
configuration; `vp run benchmark --include-strict` compares both profiles.
Compatibility checks always cover both. These checks establish the tested
subset, not compatibility with every live API or client. Corpus counts measure
compilation and schema export, not execution of every valid input. Stripe has
pinned-spec request tests covering query/form encoding, metadata, uploads and PDF
downloads; representative query/form requests also run through a local HTTP
listener. Live Stripe sandbox verification has not been performed.

## Security

Load **trusted specifications**: they select API targets and can contain expensive
schemas. HTTP binds to loopback and checks Host/Origin. Upstream credentials do
**not** authenticate incoming MCP clients or isolate tenants; remote hosting needs
separate authentication and authorization. Tool annotations do not enforce approval.

Successful API responses may contain sensitive or untrusted content. API error
bodies are withheld, but successful responses are returned unchanged. Cancellation
aborts local HTTP work and cannot undo an upstream mutation already performed.

## License

Project code is [MIT](LICENSE). Third-party test
fixtures retain their upstream licenses and notices and are excluded from the
npm package. The manifests in `fixtures/sources.json` and
`fixtures/json-schema/sources.json` record pinned sources, license files and
verification hashes. Fixture documents are unchanged; larger files are gzip
compressed.

The QUERY/tag examples are by the OpenAPI Initiative, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
