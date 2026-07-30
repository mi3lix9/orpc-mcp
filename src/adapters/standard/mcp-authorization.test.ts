import { os } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { expectTypeOf } from 'vitest'
import * as z from 'zod'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  FIRST_MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
} from '../../constants'
import { mcp } from '../../meta'
import { MCPHandler } from '../fetch/mcp-handler'

interface AuthorizationContext {
  allowedNames: Set<string>
}

const executions = {
  middleware: 0,
  alpha: 0,
  config: 0,
  planet: 0,
  plan: 0,
}

const alpha = os.$context<AuthorizationContext>()
  .use(async ({ next }) => {
    executions.middleware++
    return next()
  })
  .meta(mcp.tool({ description: 'Alpha tool' }))
  .input(z.object({ value: z.string() }))
  .handler(({ input }) => {
    executions.alpha++
    return `alpha:${input.value}`
  })

const beta = os.$context<AuthorizationContext>()
  .meta(mcp.tool({ description: 'Beta tool' }))
  .input(z.object({}))
  .handler(() => 'beta')

const gamma = os.$context<AuthorizationContext>()
  .meta(mcp.tool({ description: 'Gamma tool' }))
  .input(z.object({}))
  .handler(() => 'gamma')

const config = os.$context<AuthorizationContext>()
  .meta(mcp.resource({ uri: 'config://app', mimeType: 'text/plain' }))
  .output(z.string())
  .handler(() => {
    executions.config++
    return 'enabled=true'
  })

const planet = os.$context<AuthorizationContext>()
  .meta(mcp.resource({ uriTemplate: 'planet://{id}', mimeType: 'application/json' }))
  .input(z.object({ id: z.string() }))
  .handler(({ input }) => {
    executions.planet++
    return { id: input.id }
  })

const plan = os.$context<AuthorizationContext>()
  .meta(mcp.prompt({ description: 'Plan something' }))
  .input(z.object({ topic: z.string() }))
  .handler(({ input }) => {
    executions.plan++
    return {
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: input.topic } }],
    }
  })

const router = { alpha, beta, gamma, config, planet, plan }

interface RPCResponse {
  result?: Record<string, unknown>
  error?: { code: number, message: string, data?: unknown }
}

function createHandler(
  authorizeCatalogEntry: NonNullable<ConstructorParameters<typeof MCPHandler<AuthorizationContext>>[1]>['authorizeCatalogEntry']
    = ({ entry, context }) => context.allowedNames.has(entry.name),
): MCPHandler<AuthorizationContext> {
  return new MCPHandler(router, {
    converters: [new ZodToJsonSchemaConverter()],
    authorizeCatalogEntry,
  })
}

const unknownRouter = {
  noop: os.$context<AuthorizationContext>().handler(() => undefined),
}

function createUnknownHandler(): MCPHandler<AuthorizationContext> {
  return new MCPHandler(unknownRouter, {
    converters: [new ZodToJsonSchemaConverter()],
  })
}

async function rpc(
  handler: MCPHandler<AuthorizationContext>,
  message: Record<string, unknown>,
  context: AuthorizationContext,
  headers: Record<string, string> = {},
): Promise<RPCResponse> {
  const { response } = await handler.handle(new Request('https://x/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(message),
  }), { context })
  return (response as Response).json() as Promise<RPCResponse>
}

function names(response: RPCResponse, key: string): string[] {
  const entries = response.result?.[key] as Array<{ name: string }>
  return entries.map(entry => entry.name)
}

function modernMessage(method: string): { message: Record<string, unknown>, headers: Record<string, string> } {
  return {
    message: {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: FIRST_MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: 'authorization-test', version: '1.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    },
    headers: {
      'mcp-protocol-version': FIRST_MODERN_PROTOCOL_VERSION,
      'mcp-method': method,
    },
  }
}

const none: AuthorizationContext = { allowedNames: new Set() }

describe('catalog discovery authorization', () => {
  it('filters every catalog independently for each request context', async () => {
    const handler = createHandler()
    const member = { allowedNames: new Set(['beta', 'config', 'plan']) }
    const admin = { allowedNames: new Set(['alpha', 'beta', 'planet']) }

    expect(names(await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, member), 'tools')).toEqual(['beta'])
    expect(names(await rpc(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, admin), 'tools')).toEqual(['alpha', 'beta'])
    expect(names(await rpc(handler, { jsonrpc: '2.0', id: 3, method: 'resources/list' }, member), 'resources')).toEqual(['config'])
    expect(names(await rpc(handler, { jsonrpc: '2.0', id: 4, method: 'resources/list' }, admin), 'resources')).toEqual([])
    expect(names(await rpc(handler, { jsonrpc: '2.0', id: 5, method: 'resources/templates/list' }, admin), 'resourceTemplates')).toEqual(['planet'])
    expect(names(await rpc(handler, { jsonrpc: '2.0', id: 6, method: 'resources/templates/list' }, member), 'resourceTemplates')).toEqual([])
    expect(names(await rpc(handler, { jsonrpc: '2.0', id: 7, method: 'prompts/list' }, member), 'prompts')).toEqual(['plan'])
    expect(names(await rpc(handler, { jsonrpc: '2.0', id: 8, method: 'prompts/list' }, admin), 'prompts')).toEqual([])
  })

  it('derives legacy and modern capabilities from the authorized catalog', async () => {
    const handler = createHandler()
    const legacy = await rpc(handler, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }, none)
    expect(legacy.result?.capabilities).toEqual({})

    const modern = modernMessage('server/discover')
    const discovered = await rpc(handler, modern.message, none, modern.headers)
    expect((discovered.result?.capabilities)).toEqual({})
  })

  it('preserves registry order when async decisions complete out of order', async () => {
    const completionOrder: string[] = []
    const handler = createHandler(({ entry, context }) => {
      expectTypeOf(context.allowedNames).toEqualTypeOf<Set<string>>()
      const decision = entry.name === 'alpha'
        ? Promise.resolve().then(() => entry.kind === 'tool')
        : Promise.resolve(entry.kind === 'tool')
      return decision.then((allowed) => {
        completionOrder.push(entry.name)
        return allowed
      })
    })

    expect(names(await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, none), 'tools'))
      .toEqual(['alpha', 'beta', 'gamma'])
    expect(completionOrder).toEqual(['beta', 'gamma', 'alpha'])
  })
})


describe('catalog invocation authorization', () => {
  beforeEach(() => {
    for (const key of Object.keys(executions) as Array<keyof typeof executions>) {
      executions[key] = 0
    }
  })

  it('makes denied direct invocations identical to absent entries without executing procedures', async () => {
    const deniedHandler = createHandler()
    const unknownHandler = createUnknownHandler()
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'alpha', arguments: { value: 'x' } } },
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'config://app' } },
      { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'planet://mars' } },
      { jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'plan', arguments: { topic: 'x' } } },
    ]

    for (const message of messages) {
      const denied = await rpc(deniedHandler, message, none)
      const absent = await rpc(unknownHandler, message, none)
      expect(denied.error).toEqual(absent.error)
    }
    expect(executions).toEqual({ middleware: 0, alpha: 0, config: 0, planet: 0, plan: 0 })
  })

  it('passes invocation params and permitted calls through validation, middleware, and handlers', async () => {
    let invocationParams: Record<string, unknown> | undefined
    const handler = createHandler(({ entry, operation, context, params }) => {
      if (operation === 'invoke') {
        invocationParams = params
      }
      return context.allowedNames.has(entry.name)
    })
    const context = { allowedNames: new Set(['alpha']) }

    const invalid = await rpc(handler, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'alpha', arguments: { value: 42 } },
    }, context)
    expect(invalid.result).toMatchObject({ isError: true })
    expect(executions.alpha).toBe(0)

    executions.middleware = 0
    const permitted = await rpc(handler, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'alpha', arguments: { value: 'ok' } },
    }, context)
    expect(permitted.error).toBeUndefined()
    expect(invocationParams).toEqual({ name: 'alpha', arguments: { value: 'ok' } })
    expect(executions.middleware).toBe(1)
    expect(executions.alpha).toBe(1)
  })
})