import type { PlanetRequestContext, PlanetSaaSExample } from '../../examples/planet-multitenant'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as z from 'zod'
import {
  createPlanetSaaSExample,
  planetContext,

} from '../../examples/planet-multitenant'
import {
  startPlanetSaaSServer,
  stopPlanetSaaSServer,
} from '../../examples/planet-multitenant-server'
import { FIRST_MODERN_PROTOCOL_VERSION } from '../constants'

const toolListResponse = z.object({
  result: z.object({
    tools: z.array(z.object({ name: z.string() })),
  }),
})

const resultResponse = z.object({
  result: z.record(z.string(), z.unknown()),
})

const errorResponse = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
  }),
})

async function rpc(
  handler: PlanetSaaSExample['handler'],
  context: PlanetRequestContext,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const { response } = await handler.handle(new Request('https://planets.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), { context })
  if (response === undefined) {
    throw new Error(`MCP request was not matched: ${method}`)
  }
  return response.json()
}

async function connectClient(url: URL, context: PlanetRequestContext): Promise<Client> {
  const client = new Client(
    { name: `planet-${context.actorId}`, version: '1.0.0' },
    { versionNegotiation: { mode: { pin: FIRST_MODERN_PROTOCOL_VERSION } } },
  )
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        'x-actor-id': context.actorId,
        'x-role': context.role,
        'x-tenant-id': context.tenantId,
      },
    },
  }))
  return client
}

describe('multi-tenant planet SaaS example', () => {
  it('separates admin catalog permissions from tenant-level resource authorization', async () => {
    const { handler } = createPlanetSaaSExample()
    const tenantAdmin = planetContext('tenant-a', 'admin-a', 'admin')
    const tenantMember = planetContext('tenant-a', 'member-a', 'member')
    const otherTenantAdmin = planetContext('tenant-b', 'admin-b', 'admin')

    const [adminCatalog, memberCatalog] = await Promise.all([
      rpc(handler, tenantAdmin, 'tools/list'),
      rpc(handler, tenantMember, 'tools/list'),
    ])
    expect(toolListResponse.parse(adminCatalog).result.tools.map(tool => tool.name))
      .toEqual(['listPlanets', 'createPlanet'])
    expect(toolListResponse.parse(memberCatalog).result.tools.map(tool => tool.name))
      .toEqual(['listPlanets'])

    const created = await rpc(handler, tenantAdmin, 'tools/call', {
      name: 'createPlanet',
      arguments: { id: 'earth', name: 'Earth' },
    })
    expect(resultResponse.parse(created).result).toBeDefined()

    const guessedAdminTool = errorResponse.parse(await rpc(handler, tenantMember, 'tools/call', {
      name: 'createPlanet',
      arguments: { id: 'mars', name: 'Mars' },
    }))
    expect(guessedAdminTool.error).toEqual({
      code: -32602,
      message: 'Unknown tool: createPlanet',
    })

    const sameTenantRead = await rpc(handler, tenantMember, 'resources/read', { uri: 'planet://earth' })
    expect(resultResponse.parse(sameTenantRead).result).toBeDefined()

    const crossTenantRead = errorResponse.parse(
      await rpc(handler, otherTenantAdmin, 'resources/read', { uri: 'planet://earth' }),
    )
    expect(crossTenantRead.error).toEqual({
      code: -32002,
      message: 'Planet not found',
    })
  })

  it('runs through a real HTTP server with official MCP clients', async () => {
    const running = await startPlanetSaaSServer()
    const clients: Client[] = []
    try {
      const tenantAdmin = await connectClient(running.url, planetContext('tenant-a', 'admin-a', 'admin'))
      clients.push(tenantAdmin)
      const tenantMember = await connectClient(running.url, planetContext('tenant-a', 'member-a', 'member'))
      clients.push(tenantMember)
      const otherTenantAdmin = await connectClient(running.url, planetContext('tenant-b', 'admin-b', 'admin'))
      clients.push(otherTenantAdmin)

      expect(tenantAdmin.getProtocolEra()).toBe('modern')
      expect((await tenantAdmin.listTools()).tools.map(tool => tool.name))
        .toEqual(['listPlanets', 'createPlanet'])
      expect((await tenantMember.listTools()).tools.map(tool => tool.name))
        .toEqual(['listPlanets'])

      await tenantAdmin.callTool({
        name: 'createPlanet',
        arguments: { id: 'earth', name: 'Earth' },
      })
      await expect(tenantMember.callTool({
        name: 'createPlanet',
        arguments: { id: 'mars', name: 'Mars' },
      })).rejects.toMatchObject({ code: -32602 })

      const sameTenant = await tenantMember.readResource({ uri: 'planet://earth' })
      expect(sameTenant.contents[0]).toMatchObject({
        uri: 'planet://earth',
        mimeType: 'application/json',
      })
      await expect(otherTenantAdmin.readResource({ uri: 'planet://earth' }))
        .rejects
        .toMatchObject({ code: -32002, message: 'Planet not found' })
    }
    finally {
      await Promise.all(clients.map(client => client.close()))
      await stopPlanetSaaSServer(running.server)
    }
  })
})
