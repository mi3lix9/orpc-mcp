import { os } from '@orpc/server'
import { expect, expectTypeOf, it } from 'vitest'
import { MCPHandler } from './adapters/fetch/mcp-handler'
import { mcp } from './meta'

interface TestContext {
  role: 'admin' | 'member'
}

const router = {
  ping: os.$context<TestContext>()
    .meta(mcp.tool())
    .handler(() => 'pong'),
}

it('infers authorization context from the handler router', () => {
  const handler = new MCPHandler(router, {
    authorizeCatalogEntry: (options) => {
      expectTypeOf(options.context.role).toEqualTypeOf<TestContext['role']>()
      expectTypeOf(options.entry.path).toEqualTypeOf<readonly string[]>()
      return options.context.role === 'admin'
    },
  })
  expect(handler).toBeInstanceOf(MCPHandler)
})
