# @repo/a2a

## What the package is

`@repo/a2a` holds the A2A 1.0 wire types and their zod schemas, the agent card builder, the JSON-RPC and HTTP+JSON codecs, the error mapping, and an HTTP client for calling a peer. It imports only `zod`. It has no database code, no Worker APIs and no other workspace package. Keep it that way.

## Entry points

Each module is an entry in the `exports` map of `package.json`. There is no barrel file, so import the module you need, for example `@repo/a2a/client`. `oneof.ts` is internal and not exported.

| Entry point | Holds |
|---|---|
| `./protocol` | The A2A version, the header names, the two bindings and the agent card path. |
| `./extensions` | The URIs of the pairing and hops extensions, and the hops metadata key. |
| `./messages` | Struct, part, message and artifact schemas. |
| `./states` | Task states, the terminal and interrupted groups, and their predicates. |
| `./tasks` | Task, task status and the status and artifact update events. |
| `./requests` | `SendMessage` request and response, push config and the `ListTasks` response. |
| `./security` | Security scheme, OAuth flow and security requirement schemas. |
| `./agent-card` | The agent card schema and `buildAgentCard`. |
| `./jsonrpc` | Method names, request and response schemas, builders and the parse functions. |
| `./rest` | The HTTP+JSON route table and `matchRestRoute`. |
| `./errors` | The error tables, `ErrorInfo`, and the JSON-RPC and REST error builders. |
| `./proto-names` | `acceptProtoNames`, which renames proto spellings to camelCase. |
| `./client` | `createA2aClient`, `readAgentCard`, `pickInterface`, `taskText` and `A2aClientError`. |
| `./peer-fetch` | The `A2aFetch` type that the caller injects. |

## How a server uses it

The route layer reads the request body and parses it. `parseJsonRpcRequest` reads a JSON-RPC body and never throws. It returns either the method and params or the error response to send. For HTTP+JSON, `matchRestRoute` takes the verb and the path under the interface URL and returns the operation with its decoded path parameters. The route layer then parses the body with a schema such as `sendMessageRequestSchema` and calls a service. Each route's `streaming` flag, and `JSONRPC_STREAMING_METHODS`, tell the route layer which operations answer with `text/event-stream`.

The route layer words the answer with the codecs. `buildJsonRpcResult` and `buildJsonRpcErrorResponse` make a JSON-RPC answer. `jsonRpcError` makes its `error` member. `restErrorBody` and `errorStatus` make an HTTP+JSON error. `buildAgentCard` builds the card that a published agent serves.

## How a client uses it

`createA2aClient` takes a credential, an `A2aFetch`, the interface to call and optional limits and a clock. The fetch comes from the caller. `peer-fetch.ts` only declares the type. The app supplies a fetch that refuses private addresses and redirects, requires HTTPS outside dev, times out, and dispatches in-process for its own origin. Tests supply a fake peer. The client sets `redirect: "manual"` and its own timeout on each call. Its defaults are 15 seconds and 1 MiB of body.

`pickInterface` chooses a JSONRPC interface at 1.0, then any 1.0 interface, then the first one. It counts only the bindings this package speaks. `readAgentCard` fetches a card and validates it.

The client tolerates some Hermes habits. `agentCardSchema` ignores unknown fields such as `url`, `security` and `stateTransitionHistory`. `security.ts` reads the legacy `{ "type": "http", "scheme": ... }` scheme as an HTTP auth scheme. A JSON-RPC error needs only `code` and `message`. A REST error body may carry `error.message` or a top-level `message`. A 401 or 403 becomes an `auth` error. An OAuth token is dropped and the call is retried once on a 401. A text part may carry `mediaType`. A card with no `supportedInterfaces` fails.

Every failure is an `A2aClientError` with a `kind`: `auth`, `http`, `invalid_response`, `network`, `rpc`, `timeout` or `too_large`. Its message never carries the credential, the token or the request body.

## Errors

The A2A errors follow section 5.4 of the v1.0.0 specification. The JSON-RPC errors follow section 9.5, which gives no HTTP mapping, so the package uses the usual one.

| Name | JSON-RPC code | HTTP+JSON status | gRPC status |
|---|---|---|---|
| `TaskNotFoundError` | -32001 | 404 | NOT_FOUND |
| `TaskNotCancelableError` | -32002 | 409 | FAILED_PRECONDITION |
| `PushNotificationNotSupportedError` | -32003 | 400 | UNIMPLEMENTED |
| `UnsupportedOperationError` | -32004 | 400 | UNIMPLEMENTED |
| `ContentTypeNotSupportedError` | -32005 | 415 | INVALID_ARGUMENT |
| `InvalidAgentResponseError` | -32006 | 502 | INTERNAL |
| `ExtendedAgentCardNotConfiguredError` | -32007 | 400 | FAILED_PRECONDITION |
| `ExtensionSupportRequiredError` | -32008 | 400 | FAILED_PRECONDITION |
| `VersionNotSupportedError` | -32009 | 400 | UNIMPLEMENTED |
| `JSONParseError` | -32700 | 400 | INVALID_ARGUMENT |
| `InvalidRequestError` | -32600 | 400 | INVALID_ARGUMENT |
| `MethodNotFoundError` | -32601 | 404 | NOT_FOUND |
| `InvalidParamsError` | -32602 | 400 | INVALID_ARGUMENT |
| `InternalError` | -32603 | 500 | INTERNAL |

The first nine rows are the A2A errors. The last five are the JSON-RPC protocol errors. A2A errors carry a `google.rpc.ErrorInfo` with the domain `a2a-protocol.org`. Its `reason` is the name without `Error` in upper snake case, such as `TASK_NOT_FOUND`. Protocol errors carry no `ErrorInfo`. On JSON-RPC the code identifies the error, and the package sets no HTTP status for that binding. `errorStatus` gives the HTTP status for HTTP+JSON. `restErrorBody` gives the `google.rpc.Status` body, with the gRPC name in `status`.

## Rules that are easy to break

- Import only `zod` and this package's own files. Do not add a database, a Worker API or another workspace package.
- Our own cards use the proto shape only: `httpAuthSecurityScheme` and `securityRequirements`. The client reads both that shape and the legacy Hermes shape.
- `acceptProtoNames` exists because ProtoJSON accepts both `taskId` and `task_id`, and the official TCK sends proto names over JSON-RPC. The schemas know only camelCase. The package does not call it itself, so a caller runs it on a body before schema parsing. The camelCase spelling wins when a sender gives both. The contents of `data` and `metadata` are left as they are.
- REST and JSON-RPC bodies are both `application/json`.
- Add a new error to `A2A_ERRORS` or `PROTOCOL_ERRORS` in `errors.ts`. Both builders read those tables.
- A `{name}` in a REST path matches one path segment. The `/{tenant}` variants are not served.

## Tests

Run the tests in this package with `bun test` from `packages/a2a`. The `typecheck` script runs `tsc --noEmit`. The tests use the fixtures in `src/fixtures/`, which include the Hermes card, message, push reply and RPC error.
