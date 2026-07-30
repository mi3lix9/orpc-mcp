import { Readable, Writable } from 'node:stream'
import { os } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { expectTypeOf } from 'vitest'
import * as z from 'zod'
import {
  CLIENT_CAPABILITIES_META_KEY,
  FIRST_MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
} from '../../constants'
import { mcp } from '../../meta'
import { MCPHandler } from './mcp-handler'

const greet = os
  .meta(mcp.tool({ title: 'Greet', description: 'Greet a person' }))
  .input(z.object({ name: z.string() }))
  .output(z.object({ message: z.string() }))
  .handler(({ input }) => ({ message: `Hello, ${input.name}!` }))

const router = { greet }

function createHandler() {
  return new MCPHandler(router, { converters: [new ZodToJsonSchemaConverter()] })
}

/**
 * Feed `lines` (already terminated with `\n` as needed) through the stdio
 * handler and return the parsed JSON-RPC response lines, in order.
 */
async function drive(handler: MCPHandler<Record<never, never>>, payload: string): Promise<any[]> {
  const input = Readable.from([payload])
  const chunks: string[] = []
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })

  await handler.listen({ context: {}, input, output })

  const joined = chunks.join('').trim()
  if (joined.length === 0) {
    return []
  }
  return joined.split('\n').map(line => JSON.parse(line))
}

describe('mCPHandler (stdio)', () => {
  it('responds to a single initialize line with exactly one response', async () => {
    const line = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`
    const responses = await drive(createHandler(), line)

    expect(responses).toHaveLength(1)
    expect(responses[0].jsonrpc).toBe('2.0')
    expect(responses[0].id).toBe(1)
    expect(typeof responses[0].result.protocolVersion).toBe('string')
  })

  it('processes multiple lines and emits responses in order', async () => {
    const payload
      = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`
        + `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`
    const responses = await drive(createHandler(), payload)

    expect(responses).toHaveLength(2)
    expect(responses.map(r => r.id)).toEqual([1, 2])
    expect(typeof responses[0].result.protocolVersion).toBe('string')
    expect(Array.isArray(responses[1].result.tools)).toBe(true)
    expect(responses[1].result.tools.map((t: any) => t.name)).toEqual(['greet'])
  })

  it('ignores blank lines without crashing or emitting extra output', async () => {
    const payload
      = `\n`
        + `   \n`
        + `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`
        + `\n`
    const responses = await drive(createHandler(), payload)

    expect(responses).toHaveLength(1)
    expect(responses[0].id).toBe(1)
  })

  it('emits a parse error for an invalid JSON line', async () => {
    const payload = `this is not json\n`
    const responses = await drive(createHandler(), payload)

    expect(responses).toHaveLength(1)
    expect(responses[0].jsonrpc).toBe('2.0')
    expect(responses[0].id).toBe(null)
    expect(responses[0].error.code).toBe(-32700)
    expect(responses[0].error.message).toBe('Parse error')
  })

  it('rejects an over-limit line by its raw length, even when whitespace-padded', async () => {
    const handler = new MCPHandler(router, { converters: [new ZodToJsonSchemaConverter()], maxMessageLength: 64 })
    // The message trims to well under 64 chars, but the padded raw line exceeds it.
    const padded = `${' '.repeat(100)}${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`
    const responses = await drive(handler, padded)

    expect(responses).toHaveLength(1)
    expect(responses[0].id).toBe(null)
    expect(responses[0].error.code).toBe(-32600)
    expect(responses[0].error.message).toBe('Message too large')
  })

  it('recovers after an invalid JSON line and keeps processing valid lines', async () => {
    const payload
      = `not json at all\n`
        + `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} })}\n`
    const responses = await drive(createHandler(), payload)

    expect(responses).toHaveLength(2)
    expect(responses[0].error.code).toBe(-32700)
    expect(responses[1].id).toBe(7)
    expect(typeof responses[1].result.protocolVersion).toBe('string')
  })
})

describe('mCPHandler (stdio) — modern era', () => {
  /** A modern-era line. stdio carries no headers, so the envelope is the only era signal. */
  function modernLine(message: Record<string, unknown>, meta?: Record<string, unknown>): string {
    const params = (message.params ?? {}) as Record<string, unknown>
    return `${JSON.stringify({
      ...message,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: FIRST_MODERN_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
          ...meta,
        },
      },
    })}\n`
  }

  it('serves a modern request with no headers at all', async () => {
    // The SEP-2243 standard request headers are Streamable-HTTP-only; requiring
    // them here would reject every valid modern stdio message.
    const responses = await drive(createHandler(), modernLine({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))

    expect(responses).toHaveLength(1)
    expect(responses[0].result.resultType).toBe('complete')
    expect(responses[0].result.tools.map((t: any) => t.name)).toEqual(['greet'])
  })

  it('answers server/discover over stdio', async () => {
    const responses = await drive(createHandler(), modernLine({ jsonrpc: '2.0', id: 1, method: 'server/discover' }))

    expect(responses[0].result.supportedVersions).toEqual([FIRST_MODERN_PROTOCOL_VERSION])
    expect(responses[0].result.resultType).toBe('complete')
  })

  it('still validates the envelope over stdio', async () => {
    const responses = await drive(
      createHandler(),
      modernLine({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { [CLIENT_CAPABILITIES_META_KEY]: undefined }),
    )

    expect(responses[0].error.code).toBe(-32602)
    expect(responses[0].error.message).toContain(CLIENT_CAPABILITIES_META_KEY)
  })

  it('interleaves both eras on one stream without leaking state', async () => {
    const legacyInit = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const legacyList = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    const payload = `${legacyInit}\n${modernLine({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}${legacyList}\n`
    const responses = await drive(createHandler(), payload)

    expect(responses.map(r => r.id)).toEqual([1, 2, 3])
    expect(responses[0].result.protocolVersion).toBe('2025-11-25')
    expect(responses[1].result.resultType).toBe('complete')
    // The legacy request after a modern one must stay legacy-shaped.
    expect(responses[2].result.resultType).toBeUndefined()
  })
})

describe('mCPHandler (stdio) catalog authorization', () => {
  it('applies the typed listen context to catalog lists and calls', async () => {
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
    const payload = `${[
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'visible' } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hidden' } },
    ].map(message => JSON.stringify(message)).join('\n')}\n`
    const input = Readable.from([payload])
    const chunks: string[] = []
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString())
        callback()
      },
    })

    await handler.listen({
      context: { allowedNames: new Set(['visible']) },
      input,
      output,
    })
    const responses: unknown[] = chunks.join('').trim().split('\n').map(line => JSON.parse(line))

    const listed = z.object({
      result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
    }).parse(responses[0])
    expect(listed.result.tools.map(tool => tool.name)).toEqual(['visible'])
    expect(z.object({ result: z.record(z.string(), z.unknown()) }).parse(responses[1]).result).toBeDefined()
    expect(z.object({ error: z.object({ code: z.number() }) }).parse(responses[2]).error.code).toBe(-32602)
  })
})
