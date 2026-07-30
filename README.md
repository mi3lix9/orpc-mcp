# orpc-mcp

Serve an [oRPC](https://orpc.dev) router as an [MCP](https://modelcontextprotocol.io) server. The **same** procedures you already serve over RPC and OpenAPI become MCP **tools**, **resources**, and **prompts** — usable by clients like Claude, ChatGPT, and IDEs, with the same types, validation, and middleware.

> [!NOTE]
> This is a **community package**, not part of oRPC core. It was proposed in [middleapi/orpc#1604](https://github.com/middleapi/orpc/pull/1604); the maintainer opted to keep MCP out of core for now and promote it as an ecosystem package. It serves MCP revisions `2024-10-07` through `2026-07-28` and oRPC `v2` (currently in beta).

## Installation

```sh
npm install orpc-mcp
# pnpm add orpc-mcp / yarn add orpc-mcp / bun add orpc-mcp
```

oRPC packages are peer dependencies — install them at `2.0.0-beta.16` or later:

```sh
npm install @orpc/server@beta @orpc/client@beta @orpc/contract@beta @orpc/json-schema@beta @orpc/shared@beta
```

You also need a JSON Schema converter for your validation library, e.g. `@orpc/zod@beta` or `@orpc/valibot@beta`.

## Setup

Exposing a procedure to MCP is **opt-in**: annotate it with `mcp.tool`, `mcp.resource`, or `mcp.prompt`. MCP metadata is independent of any `openapi` meta, so a single procedure can be served over REST and MCP at the same time.

```ts
import { os } from '@orpc/server'
import { mcp } from 'orpc-mcp'
import * as z from 'zod'

export const createPlanet = os
  .meta(mcp.tool({ description: 'Create a new planet' }))
  .input(z.object({ name: z.string() }))
  .output(z.object({ id: z.string(), name: z.string() }))
  .handler(({ input }) => ({ id: crypto.randomUUID(), name: input.name }))

export const router = { createPlanet }
```

Then serve the router with one of the `MCPHandler` adapters.

## Tools

Tools are functions the model can call. A procedure's `.input()` becomes the tool's JSON Schema, its return value becomes the result, and its `.output()` adds an output schema plus structured content. Thrown [typed errors](https://orpc.dev/docs/error-handling) are reported back to the model as in-band tool errors, so it can react to them.

```ts
export const createPlanet = os
  .meta(mcp.tool({
    description: 'Create a new planet',
    annotations: { destructiveHint: false },
  }))
  .input(CreatingPlanetSchema)
  .output(PlanetSchema)
  .handler(({ input }) => create(input))
```

Behavior hints — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — go in `annotations`.

## Resources

Resources expose read-only data addressed by a URI. Use a fixed `uri` for a single resource, or a `uriTemplate` whose variables map to the procedure's input.

```ts
// Static resource
export const appConfig = os
  .meta(mcp.resource({ uri: 'config://app', mimeType: 'application/json' }))
  .output(ConfigSchema)
  .handler(() => getConfig())

// Templated resource — `{id}` is read from the input
export const planet = os
  .meta(mcp.resource({ uriTemplate: 'planet://{id}', mimeType: 'application/json' }))
  .input(z.object({ id: z.string() }))
  .output(PlanetSchema)
  .handler(({ input }) => findPlanet(input.id))
```

> [!TIP]
> Only annotate read-only, side-effect-free procedures as resources.

## Prompts

Prompts are reusable templates a user can invoke. The arguments are derived from the procedure's `.input()`, and the handler returns the prompt messages.

```ts
export const planTrip = os
  .meta(mcp.prompt({ description: 'Plan a vacation' }))
  .input(z.object({ destination: z.string() }))
  .output(z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.object({ type: z.literal('text'), text: z.string() }),
    })),
  }))
  .handler(({ input }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Plan a trip to ${input.destination}` } }],
  }))
```

## Serving

`MCPHandler` speaks MCP over the [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) transport (Fetch or Node.js) or over stdio. Pass the schema converter for your validation library — the same converters used by `@orpc/openapi`.

It is built on oRPC's standard request/response flow, so tool, resource, and prompt calls run through your [middleware](https://orpc.dev/docs/middleware), validation, and context, and any handler plugin (CORS, request limit, OpenTelemetry) composes as usual.

### Fetch

```ts
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { MCPHandler } from 'orpc-mcp/fetch'

const handler = new MCPHandler(router, {
  serverInfo: { name: 'planets', version: '1.0.0' },
  converters: [new ZodToJsonSchemaConverter()],
})

export async function POST(request: Request) {
  const { response } = await handler.handle(request, { context: {} })
  return response ?? new Response('Not found', { status: 404 })
}
```

### Node.js

```ts
import { createServer } from 'node:http'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { MCPHandler } from 'orpc-mcp/node'

const handler = new MCPHandler(router, { converters: [new ZodToJsonSchemaConverter()] })

createServer((req, res) => handler.handle(req, res, { context: {} })).listen(3000)
```

### stdio

For clients that launch your server as a subprocess (Claude Desktop, IDEs):

```ts
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { MCPHandler } from 'orpc-mcp/stdio'

await new MCPHandler(router, { converters: [new ZodToJsonSchemaConverter()] })
  .listen({ context: {} })
```

## Authorization

Authentication and authorization are your application's responsibility — this package stays unopinionated about tokens, scopes, and OAuth. Supply request-derived values as `context` when calling the handler, then enforce them with ordinary [middleware](https://orpc.dev/docs/middleware), which runs for every tool, resource, and prompt call.

```ts
export const authed = os.use(({ context, next, errors }) => {
  const user = verifyToken(context.authToken)
  if (!user)
    throw errors.UNAUTHORIZED()
  return next({ context: { user } })
})

export const deletePlanet = authed
  .meta(mcp.tool({ description: 'Delete a planet' }))
  .handler(({ context }) => remove(context.user))
```

A thrown `UNAUTHORIZED` reaches the model as an in-band tool error, or a resource/prompt request as a protocol error.

## Security

For HTTP servers reachable by browsers, enable Origin and Host validation to guard against DNS-rebinding attacks. A missing `Origin` header still passes, so non-browser clients are unaffected.

```ts
export const handler = new MCPHandler(router, {
  converters: [new ZodToJsonSchemaConverter()],
  enableDnsRebindingProtection: true,
  allowedOrigins: ['https://your-app.example'],
  allowedHosts: ['your-app.example'],
})
```

## One Router, Every Surface

Because MCP exposure lives in procedure metadata, a single router can be mounted on multiple handlers at once — RPC, OpenAPI, and MCP — over the same instance:

```ts
export const handlers = {
  rpc: new RPCHandler(router), // typed oRPC clients
  openapi: new OpenAPIHandler(router), // REST + OpenAPI
  mcp: new MCPHandler(router, { converters: [new ZodToJsonSchemaConverter()] }), // MCP tools / resources / prompts
}
```

## Protocol Revisions

`orpc-mcp` speaks both MCP wire eras from one endpoint, and classifies **every
request independently** — nothing is remembered between them:

|                 | legacy era                  | modern era                                                |
| --------------- | --------------------------- | --------------------------------------------------------- |
| Revisions       | `2024-10-07` … `2025-11-25` | `2026-07-28`                                              |
| Opening         | `initialize` handshake      | none; `server/discover` advertises                        |
| Client identity | once, at `initialize`       | per request, in the `_meta` envelope                      |
| Results         | as-is                       | `resultType`, plus `ttlMs`/`cacheScope` on cacheable ones |

A request is modern when it carries the reserved
`io.modelcontextprotocol/protocolVersion` `_meta` key. Classification is
**body-primary**: the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`
headers are cross-checked against the body and rejected on disagreement
(`-32020`), but a header alone never promotes a request to the modern era.

Because the modern era is stateless by construction, any request can land on any
instance behind a plain round-robin load balancer — no shared session store.

### Cache hints

Modern-era `*/list`, `resources/read` and `server/discover` results must carry
cache hints. The default is the always-safe pair — never reuse, never share:

```ts
export const handler = new MCPHandler(router, {
  converters: [new ZodToJsonSchemaConverter()],
  // Defaults to { ttlMs: 0, cacheScope: 'private' }.
  cache: { ttlMs: 60_000, cacheScope: 'public' },
})
```

Set `cacheScope: 'public'` only when the payload holds no per-user data: a shared
gateway may serve a `public` result to a different caller.

## Limitations

- One JSON-RPC message per request — batching is not supported (removed from the
  spec in `2025-06-18`; a batch carrying a modern element is rejected outright).
- Sessions, the `GET` SSE channel, and `listChanged`/`subscribe` notifications
  are not implemented. The modern era removes all three, so the stateless
  request/response design is the target, not a shortcut.
- Multi Round-Trip Requests (MRTR) are not implemented. Returning
  `resultType: "input_required"` to ask the user for input mid-call is opt-in for
  servers, and a server that never needs input is fully compliant without it.
  Consequently elicitation, sampling, and roots are unsupported — the latter two
  are deprecated as of `2026-07-28` anyway.
- The `tasks` and `subscriptions` extensions are not implemented.

## Development

```sh
pnpm install
pnpm test        # vitest, incl. an e2e suite driven by the official @modelcontextprotocol/sdk client
pnpm lint
pnpm type:check
pnpm build
```

## License

MIT
