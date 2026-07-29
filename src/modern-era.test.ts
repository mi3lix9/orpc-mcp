import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MCPHandlerOptions } from './adapters/node/mcp-handler'
import { createServer } from 'node:http'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { os } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import * as z from 'zod'
import { MCPHandler } from './adapters/node/mcp-handler'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  FIRST_MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from './constants'
import { mcp } from './meta'

// The modern (2026-07-28) era, driven both by the OFFICIAL v2 SDK client over
// real HTTP and by raw requests that perturb exactly one thing at a time.
//
// The v2 client pinned to 2026-07-28 never falls back to the legacy handshake,
// so `getProtocolEra() === 'modern'` is third-party proof that this server
// genuinely implements the era — not self-consistency.

const greet = os
  .meta(mcp.tool({ title: 'Greet', description: 'Greet a person' }))
  .input(z.object({ name: z.string() }))
  .output(z.object({ message: z.string() }))
  .handler(({ input }) => ({ message: `Hello, ${input.name}!` }))

const failing = os
  .meta(mcp.tool({ description: 'always fails' }))
  .input(z.object({}))
  .errors({ FORBIDDEN: { message: 'nope' } })
  .handler(({ errors }) => {
    throw errors.FORBIDDEN()
  })

const config = os
  .meta(mcp.resource({ uri: 'config://app', mimeType: 'text/plain' }))
  .output(z.string())
  .handler(() => 'debug=true')

const planet = os
  .meta(mcp.resource({ uriTemplate: 'planet://{id}', mimeType: 'application/json' }))
  .input(z.object({ id: z.string() }))
  .output(z.object({ id: z.string(), name: z.string() }))
  .handler(({ input }) => ({ id: input.id, name: `Planet ${input.id}` }))

const planTrip = os
  .meta(mcp.prompt({ description: 'Plan a vacation' }))
  .input(z.object({ destination: z.string() }))
  .handler(({ input }) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Plan a trip to ${input.destination}` } }],
  }))

const router = { greet, failing, config, planet, planTrip }

interface RpcError {
  code: number
  message: string
  data?: Record<string, unknown>
}

interface RpcResponse {
  jsonrpc?: string
  id?: string | number | null
  result?: Record<string, unknown>
  error?: RpcError
}

/** The `result` of a response, failing the test with the error when it is one. */
function resultOf(response: RpcResponse): Record<string, unknown> {
  if (response.result === undefined) {
    throw new Error(`expected a result, got error: ${JSON.stringify(response.error)}`)
  }
  return response.result
}

/** The `error` of a response, failing the test with the result when it is one. */
function errorOf(response: RpcResponse): RpcError {
  if (response.error === undefined) {
    throw new Error(`expected an error, got result: ${JSON.stringify(response.result)}`)
  }
  return response.error
}

/** Boot the node adapter on an ephemeral port; returns the `/mcp` URL. */
async function startServer(options: Partial<MCPHandlerOptions<Record<never, never>>> = {}): Promise<{ server: Server, url: URL }> {
  const handler = new MCPHandler(router, {
    serverInfo: { name: 'orpc-mcp-modern', version: '2.0.0' },
    converters: [new ZodToJsonSchemaConverter()],
    ...options,
  })
  const server = createServer((req, res) => {
    void handler.handle(req, res, { context: {} })
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: new URL(`http://127.0.0.1:${port}/mcp`) }
}

async function stopServer(server: Server | undefined): Promise<void> {
  if (server === undefined) {
    return
  }
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function post(url: URL, headers: Record<string, string>, body: unknown): Promise<{ status: number, body: RpcResponse }> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) as RpcResponse }
}

/** A legacy-era request: no envelope, no standard headers. */
async function legacy(url: URL, message: Record<string, unknown>): Promise<{ status: number, body: RpcResponse }> {
  return post(url, { 'content-type': 'application/json' }, message)
}

/**
 * A modern-era request, envelope and SEP-2243 headers included by default, so a
 * test can perturb exactly one thing and observe the rejection. A header set to
 * `undefined` is removed; `meta: null` omits the envelope entirely.
 */
async function modern(
  url: URL,
  message: Record<string, unknown>,
  overrides: { headers?: Record<string, string | undefined>, meta?: Record<string, unknown> | null } = {},
): Promise<{ status: number, body: RpcResponse }> {
  const method = message.method as string
  const params = (message.params ?? {}) as Record<string, unknown>
  const envelope = overrides.meta === null
    ? undefined
    : {
        [PROTOCOL_VERSION_META_KEY]: FIRST_MODERN_PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: { name: 'raw-test-client', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: {},
        ...overrides.meta,
      }

  const nameSource = method === 'resources/read' ? params.uri : params.name
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'mcp-protocol-version': FIRST_MODERN_PROTOCOL_VERSION,
    'mcp-method': method,
    ...(typeof nameSource === 'string' ? { 'mcp-name': nameSource } : {}),
  }
  for (const [key, value] of Object.entries(overrides.headers ?? {})) {
    if (value === undefined) {
      delete headers[key]
    }
    else {
      headers[key] = value
    }
  }

  return post(url, headers, {
    ...message,
    params: envelope === undefined ? params : { ...params, _meta: envelope },
  })
}

describe('official v2 SDK client <-> orpc-mcp (modern era, e2e over HTTP)', () => {
  let server: Server
  let client: Client

  beforeAll(async () => {
    const started = await startServer()
    server = started.server
    client = new Client(
      { name: 'modern-e2e-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: FIRST_MODERN_PROTOCOL_VERSION } } },
    )
    await client.connect(new StreamableHTTPClientTransport(started.url))
  })

  afterAll(async () => {
    await client?.close()
    await stopServer(server)
  })

  it('negotiates the modern era against a pinned client, which never falls back', () => {
    expect(client.getProtocolEra()).toBe('modern')
    expect(client.getNegotiatedProtocolVersion()).toBe(FIRST_MODERN_PROTOCOL_VERSION)
  })

  it('lands on the modern era from an auto-probing client too', async () => {
    // `auto` is what real clients default to once they support both eras: it
    // probes with `server/discover` and only reports `modern` if the probe
    // actually succeeded. It would silently report `legacy` on a bad probe, so
    // this covers the path a pinned client cannot.
    const fresh = await startServer()
    const probing = new Client({ name: 'auto-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
    try {
      await probing.connect(new StreamableHTTPClientTransport(fresh.url))
      expect(probing.getProtocolEra()).toBe('modern')
      expect(probing.getDiscoverResult()?.supportedVersions).toEqual([FIRST_MODERN_PROTOCOL_VERSION])
      expect((await probing.listTools()).tools.map(tool => tool.name).sort()).toEqual(['failing', 'greet'])
    }
    finally {
      await probing.close()
      await stopServer(fresh.server)
    }
  })

  it('serves a legacy default-mode client from the same endpoint', async () => {
    // The v2 client's DEFAULT is the 2025 handshake with no probe at all.
    const fresh = await startServer()
    const legacyClient = new Client({ name: 'legacy-client', version: '1.0.0' })
    try {
      await legacyClient.connect(new StreamableHTTPClientTransport(fresh.url))
      expect(legacyClient.getProtocolEra()).toBe('legacy')
      expect(legacyClient.getNegotiatedProtocolVersion()).toBe('2025-11-25')
      const result = await legacyClient.callTool({ name: 'greet', arguments: { name: 'Bo' } })
      expect(result.structuredContent).toEqual({ message: 'Hello, Bo!' })
    }
    finally {
      await legacyClient.close()
      await stopServer(fresh.server)
    }
  })

  it('advertises capabilities derived from the router via server/discover', () => {
    expect(client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    })
  })

  it('lists and calls a tool', async () => {
    const { tools } = await client.listTools()
    // Only the two tools — `config`/`planet` are resources and `planTrip` is a prompt.
    expect(tools.map(tool => tool.name).sort()).toEqual(['failing', 'greet'])

    const result = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } })
    expect(result.content).toEqual([{ type: 'text', text: '{"message":"Hello, Ada!"}' }])
    expect(result.structuredContent).toEqual({ message: 'Hello, Ada!' })
  })

  it('reports a tool failure in band so the model can react', async () => {
    const result = await client.callTool({ name: 'failing', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'nope' }])
  })

  it('reads a static resource and a templated one', async () => {
    const staticRead = await client.readResource({ uri: 'config://app' })
    expect(staticRead.contents).toEqual([{ uri: 'config://app', mimeType: 'text/plain', text: 'debug=true' }])

    const templated = await client.readResource({ uri: 'planet://mars' })
    expect(templated.contents[0]).toMatchObject({ uri: 'planet://mars', mimeType: 'application/json' })
  })

  it('lists resources, templates and prompts', async () => {
    expect((await client.listResources()).resources.map(entry => entry.uri)).toEqual(['config://app'])
    expect((await client.listResourceTemplates()).resourceTemplates.map(entry => entry.uriTemplate)).toEqual(['planet://{id}'])
    expect((await client.listPrompts()).prompts.map(entry => entry.name)).toEqual(['planTrip'])
  })

  it('gets a prompt', async () => {
    const result = await client.getPrompt({ name: 'planTrip', arguments: { destination: 'Kyoto' } })
    expect(result.description).toBe('Plan a vacation')
    expect(result.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Plan a trip to Kyoto' } }])
  })
})

describe('modern era: result envelope', () => {
  let server: Server
  let url: URL

  beforeAll(async () => {
    const started = await startServer({ cache: { ttlMs: 60_000, cacheScope: 'public' } })
    server = started.server
    url = started.url
  })
  afterAll(() => stopServer(server))

  it('stamps resultType on every result', async () => {
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'server/discover' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'greet', arguments: { name: 'x' } } },
      { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'config://app' } },
      { jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'planTrip', arguments: { destination: 'x' } } },
    ]) {
      const { body } = await modern(url, message)
      expect(resultOf(body).resultType, `${message.method} must carry resultType`).toBe('complete')
    }
  })

  it('stamps resultType on an in-band tool error alongside isError', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'failing', arguments: {} } })
    expect(resultOf(body)).toMatchObject({ resultType: 'complete', isError: true })
  })

  it('carries the configured cache hints on every cacheable result', async () => {
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'server/discover' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'resources/list' },
      { jsonrpc: '2.0', id: 4, method: 'resources/templates/list' },
      { jsonrpc: '2.0', id: 5, method: 'prompts/list' },
      { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'config://app' } },
    ]) {
      const { body } = await modern(url, message)
      expect(resultOf(body), `${message.method} must carry cache hints`).toMatchObject({ ttlMs: 60_000, cacheScope: 'public' })
    }
  })

  it('omits cache hints from results that are not cacheable', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greet', arguments: { name: 'x' } } })
    expect(resultOf(body).ttlMs).toBeUndefined()
    expect(resultOf(body).cacheScope).toBeUndefined()
  })

  it('reports server identity in the result _meta', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(resultOf(body)._meta).toEqual({ [SERVER_INFO_META_KEY]: { name: 'orpc-mcp-modern', version: '2.0.0' } })
  })

  it('defaults cache hints to the never-reuse, never-share pair', async () => {
    const fresh = await startServer()
    try {
      const { body } = await modern(fresh.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(resultOf(body)).toMatchObject({ ttlMs: 0, cacheScope: 'private' })
    }
    finally {
      await stopServer(fresh.server)
    }
  })
})

describe('modern era: server/discover', () => {
  let server: Server
  let url: URL

  beforeAll(async () => {
    const started = await startServer({ instructions: 'Be brief.' })
    server = started.server
    url = started.url
  })
  afterAll(() => stopServer(server))

  it('advertises only modern revisions, never a legacy one', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'server/discover' })
    expect(resultOf(body).supportedVersions).toEqual([FIRST_MODERN_PROTOCOL_VERSION])
  })

  it('carries instructions and capabilities, and no top-level serverInfo', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'server/discover' })
    const result = resultOf(body)
    expect(result.instructions).toBe('Be brief.')
    expect(result.capabilities).toMatchObject({ tools: { listChanged: false } })
    // Identity lives in `_meta` on this era, not as a top-level field.
    expect(result.serverInfo).toBeUndefined()
    expect(result._meta).toMatchObject({ [SERVER_INFO_META_KEY]: { name: 'orpc-mcp-modern' } })
  })

  it('is not available on the legacy era', async () => {
    const { body } = await legacy(url, { jsonrpc: '2.0', id: 1, method: 'server/discover' })
    expect(errorOf(body).code).toBe(-32601)
  })
})

describe('modern era: envelope validation', () => {
  let server: Server
  let url: URL

  beforeAll(async () => {
    const started = await startServer()
    server = started.server
    url = started.url
  })
  afterAll(() => stopServer(server))

  it('rejects a claim naming an unsupported revision with -32022 and the supported list', async () => {
    const { status, body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      meta: { [PROTOCOL_VERSION_META_KEY]: '2027-01-01' },
      headers: { 'mcp-protocol-version': '2027-01-01' },
    })
    expect(status).toBe(400)
    expect(errorOf(body).code).toBe(-32022)
    expect(errorOf(body).data).toEqual({ supported: [FIRST_MODERN_PROTOCOL_VERSION], requested: '2027-01-01' })
  })

  it('routes a claim naming a legacy revision to -32022, never to legacy handling', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      meta: { [PROTOCOL_VERSION_META_KEY]: '2025-11-25' },
      headers: { 'mcp-protocol-version': '2025-11-25' },
    })
    expect(errorOf(body).code).toBe(-32022)
  })

  it('rejects a missing clientCapabilities key with -32602 naming it', async () => {
    const { status, body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      meta: { [CLIENT_CAPABILITIES_META_KEY]: undefined },
    })
    expect(status).toBe(400)
    expect(errorOf(body).code).toBe(-32602)
    expect(errorOf(body).message).toContain(CLIENT_CAPABILITIES_META_KEY)
    expect(errorOf(body).data).toEqual({ envelope: { key: CLIENT_CAPABILITIES_META_KEY, problem: 'missing' } })
  })

  it('rejects a non-string protocolVersion claim with -32602, never silently legacy', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      meta: { [PROTOCOL_VERSION_META_KEY]: 2026 },
      headers: { 'mcp-protocol-version': undefined },
    })
    expect(errorOf(body).code).toBe(-32602)
    expect(errorOf(body).message).toContain(PROTOCOL_VERSION_META_KEY)
  })

  it('rejects a malformed clientInfo while tolerating its absence', async () => {
    const bad = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      meta: { [CLIENT_INFO_META_KEY]: { name: 'no-version' } },
    })
    expect(errorOf(bad.body).code).toBe(-32602)
    expect(errorOf(bad.body).message).toContain(CLIENT_INFO_META_KEY)

    // clientInfo is SHOULD-send, so a request without it must still succeed.
    const absent = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      meta: { [CLIENT_INFO_META_KEY]: undefined },
    })
    expect(resultOf(absent.body).resultType).toBe('complete')
  })

  it('refuses to promote a request to modern from the header alone', async () => {
    // No `_meta` at all: the whole envelope is what is missing.
    const { status, body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { meta: null })
    expect(status).toBe(400)
    expect(errorOf(body).code).toBe(-32602)
    expect(errorOf(body).message).toContain(FIRST_MODERN_PROTOCOL_VERSION)
    expect(errorOf(body).data).toMatchObject({ envelope: { missing: ['_meta'] } })
  })

  it('names every missing required key when _meta is present but empty', async () => {
    const { status, body } = await post(
      url,
      { 'content-type': 'application/json', 'mcp-protocol-version': FIRST_MODERN_PROTOCOL_VERSION, 'mcp-method': 'tools/list' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {} } },
    )
    expect(status).toBe(400)
    expect(errorOf(body).code).toBe(-32602)
    expect(errorOf(body).data).toMatchObject({
      envelope: { missing: [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY] },
    })
  })

  it('rejects an initialize carrying a modern protocol-version header', async () => {
    const { status, body } = await post(
      url,
      { 'content-type': 'application/json', 'mcp-protocol-version': FIRST_MODERN_PROTOCOL_VERSION },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    )
    expect(status).toBe(400)
    expect(errorOf(body).code).toBe(-32020)
  })

  it('answers initialize as method-not-found when it carries a valid modern envelope', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })
    expect(errorOf(body).code).toBe(-32601)
  })

  it('rejects a malformed envelope on a notification instead of acknowledging it', async () => {
    const { status, body } = await modern(url, { jsonrpc: '2.0', method: 'notifications/cancelled' }, {
      meta: { [PROTOCOL_VERSION_META_KEY]: 7 },
      headers: { 'mcp-protocol-version': undefined, 'mcp-method': undefined },
    })
    expect(status).toBe(400)
    expect(errorOf(body).code).toBe(-32602)
    expect(body.id).toBeNull()
  })

  it('still acknowledges a well-formed modern notification with 202', async () => {
    const { status } = await modern(url, { jsonrpc: '2.0', method: 'notifications/cancelled' })
    expect(status).toBe(202)
  })
})

describe('modern era: SEP-2243 standard request headers', () => {
  let server: Server
  let url: URL

  beforeAll(async () => {
    const started = await startServer()
    server = started.server
    url = started.url
  })
  afterAll(() => stopServer(server))

  it('requires Mcp-Method', async () => {
    const { status, body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      headers: { 'mcp-method': undefined },
    })
    expect(status).toBe(400)
    expect(errorOf(body).code).toBe(-32020)
    expect(errorOf(body).data).toMatchObject({ mismatch: { header: '(missing)' } })
  })

  it('rejects an Mcp-Method that disagrees with the body', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      headers: { 'mcp-method': 'prompts/list' },
    })
    expect(errorOf(body).code).toBe(-32020)
    expect(errorOf(body).data).toMatchObject({ mismatch: { header: 'prompts/list' } })
  })

  it('requires Mcp-Name when the body carries the value it mirrors', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greet', arguments: { name: 'x' } } }, {
      headers: { 'mcp-name': undefined },
    })
    expect(errorOf(body).code).toBe(-32020)
    expect(errorOf(body).message).toContain('params.name="greet"')
  })

  it('rejects an Mcp-Name that disagrees with params.name', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greet', arguments: { name: 'x' } } }, {
      headers: { 'mcp-name': 'failing' },
    })
    expect(errorOf(body).code).toBe(-32020)
  })

  it('mirrors params.uri for resources/read, not params.name', async () => {
    const ok = await modern(url, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'config://app' } })
    expect(resultOf(ok.body).resultType).toBe('complete')

    const bad = await modern(url, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'config://app' } }, {
      headers: { 'mcp-name': 'config://other' },
    })
    expect(errorOf(bad.body).code).toBe(-32020)
  })

  it('does not require Mcp-Name for methods that have no name source', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'prompts/list' }, {
      headers: { 'mcp-name': undefined },
    })
    expect(resultOf(body).resultType).toBe('complete')
  })

  it('accepts a base64 sentinel Mcp-Name and matches the decoded value', async () => {
    const encoded = `=?base64?${btoa('greet')}?=`
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greet', arguments: { name: 'x' } } }, {
      headers: { 'mcp-name': encoded },
    })
    expect(resultOf(body).resultType).toBe('complete')
  })

  it('rejects a malformed base64 sentinel rather than treating it as literal text', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greet', arguments: { name: 'x' } } }, {
      headers: { 'mcp-name': '=?base64?not-valid-base64?=' },
    })
    expect(errorOf(body).code).toBe(-32020)
    expect(errorOf(body).message).toContain('invalid Base64 sentinel')
  })

  it('tolerates surrounding whitespace in a header value', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greet', arguments: { name: 'x' } } }, {
      headers: { 'mcp-name': '  greet  ' },
    })
    expect(resultOf(body).resultType).toBe('complete')
  })

  it('rejects a protocol-version header that disagrees with the envelope', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      headers: { 'mcp-protocol-version': '2026-09-09' },
    })
    expect(errorOf(body).code).toBe(-32020)
    expect(errorOf(body).data).toMatchObject({ mismatch: { header: '2026-09-09' } })
  })

  it('accepts a modern request with no protocol-version header at all (the body is authoritative)', async () => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      headers: { 'mcp-protocol-version': undefined },
    })
    expect(resultOf(body).resultType).toBe('complete')
  })
})

describe('modern era: deleted vocabulary', () => {
  let server: Server
  let url: URL

  beforeAll(async () => {
    const started = await startServer()
    server = started.server
    url = started.url
  })
  afterAll(() => stopServer(server))

  it.each(['initialize', 'ping'])('answers the legacy-only method %s with -32601', async (method) => {
    const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method })
    expect(errorOf(body).code).toBe(-32601)
  })

  it('does not resolve a prototype key as a known method', async () => {
    for (const method of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const { body } = await modern(url, { jsonrpc: '2.0', id: 1, method })
      expect(errorOf(body).code, `${method} must not resolve`).toBe(-32601)
    }
  })

  it('rejects a batch containing a modern element', async () => {
    const { status, body } = await post(url, { 'content-type': 'application/json' }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: FIRST_MODERN_PROTOCOL_VERSION } } },
    ])
    expect(status).toBe(400)
    expect(errorOf(body).code).toBe(-32600)
  })
})

describe('era isolation', () => {
  let server: Server
  let url: URL

  beforeAll(async () => {
    const started = await startServer()
    server = started.server
    url = started.url
  })
  afterAll(() => stopServer(server))

  it('never counter-offers a modern revision from the legacy handshake', async () => {
    for (const requested of [FIRST_MODERN_PROTOCOL_VERSION, '2099-01-01', 'nonsense']) {
      const { body } = await legacy(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: requested } })
      expect(resultOf(body).protocolVersion, `initialize must not offer ${requested}`).toBe('2025-11-25')
    }
  })

  it('accepts every advertised legacy revision verbatim, including 2024-10-07', async () => {
    for (const requested of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']) {
      const { body } = await legacy(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: requested } })
      expect(resultOf(body).protocolVersion).toBe(requested)
    }
  })

  it('leaves legacy results free of modern vocabulary', async () => {
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'config://app' } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'greet', arguments: { name: 'x' } } },
      { jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'planTrip', arguments: { destination: 'x' } } },
    ]) {
      const { body } = await legacy(url, message)
      const result = resultOf(body)
      expect(result.resultType, `${message.method} must not stamp resultType on legacy`).toBeUndefined()
      expect(result.ttlMs).toBeUndefined()
      expect(result.cacheScope).toBeUndefined()
      expect(result._meta).toBeUndefined()
    }
  })

  it('serves both eras from one endpoint, interleaved, with no shared state', async () => {
    const [a, b, c, d] = await Promise.all([
      legacy(url, { jsonrpc: '2.0', id: 'l1', method: 'tools/call', params: { name: 'greet', arguments: { name: 'legacy' } } }),
      modern(url, { jsonrpc: '2.0', id: 'm1', method: 'tools/call', params: { name: 'greet', arguments: { name: 'modern' } } }),
      legacy(url, { jsonrpc: '2.0', id: 'l2', method: 'tools/call', params: { name: 'greet', arguments: { name: 'legacy' } } }),
      modern(url, { jsonrpc: '2.0', id: 'm2', method: 'tools/call', params: { name: 'greet', arguments: { name: 'modern' } } }),
    ])

    expect(resultOf(a.body).resultType).toBeUndefined()
    expect(resultOf(b.body).resultType).toBe('complete')
    expect(resultOf(c.body).resultType).toBeUndefined()
    expect(resultOf(d.body).resultType).toBe('complete')
    expect(resultOf(a.body).structuredContent).toEqual({ message: 'Hello, legacy!' })
    expect(resultOf(b.body).structuredContent).toEqual({ message: 'Hello, modern!' })
  })
})
