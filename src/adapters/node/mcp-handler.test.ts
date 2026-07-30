import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { os } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { expectTypeOf } from 'vitest'
import * as z from 'zod'
import { LATEST_PROTOCOL_VERSION, PARSE_ERROR } from '../../constants'
import { mcp } from '../../meta'
import { MCPHandler } from './mcp-handler'

const greet = os
  .meta(mcp.tool({ title: 'Greet', description: 'Greet a person' }))
  .input(z.object({ name: z.string() }))
  .output(z.object({ message: z.string() }))
  .handler(({ input }) => ({ message: `Hello, ${input.name}!` }))

const router = { greet }

describe('mCPHandler (node adapter, real server)', () => {
  let server: ReturnType<typeof createServer>
  let baseUrl: string

  beforeAll(async () => {
    const handler = new MCPHandler(router, {
      converters: [new ZodToJsonSchemaConverter()],
      serverInfo: { name: 'test', version: '0.1.0' },
    })

    server = createServer((req, res) => {
      void handler.handle(req, res, { context: {} })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, resolve)
    })

    const port = (server.address() as AddressInfo).port
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    })
  })

  function rpc(method: string, params?: Record<string, unknown>): Promise<Response> {
    return fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  }

  it('handles a POST initialize request over HTTP', async () => {
    const res = await rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION })
    expect(res.status).toBe(200)

    const json = await res.json() as any
    expect(typeof json.result.protocolVersion).toBe('string')
    expect(json.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
    expect(json.result.serverInfo).toEqual({ name: 'test', version: '0.1.0' })
    expect(json.id).toBe(1)
  })

  it('lists the MCP-opted tool over HTTP', async () => {
    const res = await rpc('tools/list')
    expect(res.status).toBe(200)

    const json = await res.json() as any
    expect(Array.isArray(json.result.tools)).toBe(true)

    const names = json.result.tools.map((t: any) => t.name)
    expect(names).toContain('greet')

    const greetTool = json.result.tools.find((t: any) => t.name === 'greet')
    expect(greetTool.title).toBe('Greet')
    expect(greetTool.inputSchema.type).toBe('object')
    expect(greetTool.inputSchema.properties).toHaveProperty('name')
  })

  it('rejects a GET request with HTTP 405', async () => {
    const res = await fetch(baseUrl, { method: 'GET' })
    await res.body?.cancel()
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('returns a JSON-RPC parse error for invalid JSON with HTTP 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
    })
    expect(res.status).toBe(400)

    const json = await res.json() as any
    expect(json.error.code).toBe(PARSE_ERROR)
    expect(json.error.code).toBe(-32700)
    expect(json.error.message).toBe('Parse error')
  })
})

describe('mCPHandler (node adapter) catalog authorization', () => {
  it('applies the typed per-request context to catalog lists and calls', async () => {
    interface CatalogContext {
      allowedNames: Set<string>
    }
    const catalogRouter = {
      visible: os.$context<CatalogContext>()
        .meta(mcp.tool())
        .handler(() => 'visible'),
      hidden: os.$context<CatalogContext>()
        .meta(mcp.tool())
        .handler(() => 'hidden'),
    }
    const handler = new MCPHandler(catalogRouter, {
      authorizeCatalogEntry: ({ entry, context }) => {
        expectTypeOf(context.allowedNames).toEqualTypeOf<Set<string>>()
        return context.allowedNames.has(entry.name)
      },
    })
    const catalogServer = createServer((req, res) => {
      const header = req.headers['x-allowed-name']
      const allowedNames = new Set(typeof header === 'string' ? [header] : [])
      void handler.handle(req, res, { context: { allowedNames } })
    })
    catalogServer.listen(0, '127.0.0.1')
    await once(catalogServer, 'listening')
    const { port } = catalogServer.address() as AddressInfo

    const send = (method: string, params?: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-allowed-name': 'visible' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })

    try {
      const listed = z.object({
        result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
      }).parse(await (await send('tools/list')).json())
      expect(listed.result.tools.map(tool => tool.name)).toEqual(['visible'])

      const permitted = z.object({ result: z.record(z.string(), z.unknown()) })
        .parse(await (await send('tools/call', { name: 'visible' })).json())
      expect(permitted.result).toBeDefined()

      const denied = z.object({ error: z.object({ code: z.number(), message: z.string() }) })
        .parse(await (await send('tools/call', { name: 'hidden' })).json())
      expect(denied.error.code).toBe(-32602)
    }
    finally {
      catalogServer.close()
      await once(catalogServer, 'close')
    }
  })
})
