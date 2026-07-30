import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PlanetRole, PlanetSaaSExample } from './planet-multitenant'
import { once } from 'node:events'
import { createServer } from 'node:http'
import {
  createPlanetSaaSExample,
  planetContext,

} from './planet-multitenant'

export interface RunningPlanetSaaSServer {
  example: PlanetSaaSExample
  server: Server
  url: URL
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export async function startPlanetSaaSServer(port = 0): Promise<RunningPlanetSaaSServer> {
  const example = createPlanetSaaSExample()
  const server = createServer((request, response) => {
    const tenantId = singleHeader(request.headers['x-tenant-id'])
    const actorId = singleHeader(request.headers['x-actor-id'])
    const role = singleHeader(request.headers['x-role'])
    if (tenantId === undefined || actorId === undefined || (role !== 'admin' && role !== 'member')) {
      response.statusCode = 401
      response.end('Missing or invalid example identity headers')
      return
    }

    void example.nodeHandler.handle(request, response, {
      context: planetContext(tenantId, actorId, role satisfies PlanetRole),
    })
  })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  return { example, server, url: new URL(`http://127.0.0.1:${address.port}/mcp`) }
}

export async function stopPlanetSaaSServer(server: Server): Promise<void> {
  server.close()
  await once(server, 'close')
}
