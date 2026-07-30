import { os } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import * as z from 'zod'
import { mcp } from '../../meta'
import { MCPHandler } from '../fetch/mcp-handler'

// five tools: tool1..tool5 (registry order = insertion order)
const router: Record<string, unknown> = {}
for (let i = 1; i <= 5; i++) {
  router[`tool${i}`] = os
    .meta(mcp.tool({ description: `Tool ${i}` }))
    .input(z.object({}))
    .handler(() => i)
}

function createHandler() {
  return new MCPHandler(router as any, {
    converters: [new ZodToJsonSchemaConverter()],
    pageSize: 2,
  })
}

function createAuthorizedHandler() {
  return new MCPHandler(router as any, {
    converters: [new ZodToJsonSchemaConverter()],
    pageSize: 2,
    authorizeCatalogEntry: ({ entry, context }) => context.allowedNames.has(entry.name),
  })
}

async function list(handler: MCPHandler<any>, cursor?: string, allowedNames = new Set<string>()): Promise<any> {
  const params = cursor === undefined ? {} : { cursor }
  const { response } = await handler.handle(
    new Request('https://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params }),
    }),
    { context: { allowedNames } },
  )
  return (response as Response).json()
}

describe('catalog pagination (tools/list)', () => {
  it('returns one page plus a nextCursor when more remain', async () => {
    const body = await list(createHandler())
    expect(body.result.tools.map((t: any) => t.name)).toEqual(['tool1', 'tool2'])
    expect(typeof body.result.nextCursor).toBe('string')
  })

  it('walks every page via nextCursor and omits it on the last page', async () => {
    const handler = createHandler()
    const pages: string[][] = []
    let cursor: string | undefined

    do {
      const body = await list(handler, cursor)
      pages.push(body.result.tools.map((t: any) => t.name))
      cursor = body.result.nextCursor
    } while (cursor !== undefined)

    // 5 items / pageSize 2 -> [2, 2, 1]; loop terminates because the last page omits nextCursor
    expect(pages).toEqual([['tool1', 'tool2'], ['tool3', 'tool4'], ['tool5']])
  })

  it('filters before pagination and validates cursors against the authorized catalog', async () => {
    const handler = createAuthorizedHandler()
    const allowedNames = new Set(['tool1', 'tool3', 'tool5'])
    const first = await list(handler, undefined, allowedNames)
    expect(first.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['tool1', 'tool3'])

    const second = await list(handler, first.result.nextCursor, allowedNames)
    expect(second.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['tool5'])
    expect(second.result.nextCursor).toBeUndefined()

    const stale = await list(handler, btoa('3'), allowedNames)
    expect(stale.error.code).toBe(-32602)
  })

  it('rejects an invalid cursor with -32602', async () => {
    const body = await list(createHandler(), '!!!not-a-cursor!!!')
    expect(body.error.code).toBe(-32602)
  })

  it('does not paginate when the catalog fits in one page (default size)', async () => {
    const handler = new MCPHandler(router as any, { converters: [new ZodToJsonSchemaConverter()] })
    const body = await list(handler)
    expect(body.result.tools).toHaveLength(5)
    expect(body.result.nextCursor).toBeUndefined()
  })
})
