import { os } from '@orpc/server'
import { expectTypeOf, test } from 'vitest'
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

test('infers authorization context from the handler router', () => {
  new MCPHandler(router, {
    authorizeCatalogEntry: (options) => {
      expectTypeOf(options.context.role).toEqualTypeOf<TestContext['role']>()
      expectTypeOf(options.entry.path).toEqualTypeOf<readonly string[]>()
      return options.context.role === 'admin'
    },
  })
})
