import type { ErrorMap, InitialInputSchema, InitialOutputSchema, Meta, MetaPlugin } from '@orpc/contract'
import type { AuthorizeCatalogEntry } from '../src/authorization'
import { os } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import * as z from 'zod'
import { MCPHandler as FetchMCPHandler } from '../src/adapters/fetch/mcp-handler'
import { MCPHandler as NodeMCPHandler } from '../src/adapters/node/mcp-handler'
import { mcp } from '../src/meta'

export type PlanetRole = 'admin' | 'member'
export type PlanetPermission = 'planets.read' | 'planets.write'

export interface PlanetRequestContext {
  actorId: string
  tenantId: string
  role: PlanetRole
  permissions: ReadonlySet<PlanetPermission>
}

export interface Planet {
  id: string
  name: string
  tenantId: string
  createdBy: string
}

export interface PlanetSaaSExample {
  handler: FetchMCPHandler<PlanetRequestContext>
  nodeHandler: NodeMCPHandler<PlanetRequestContext>
}

interface PlanetAccessMetadata {
  permission: PlanetPermission
}

const PLANET_ERRORS = {
  NOT_FOUND: { message: 'Planet not found' },
} satisfies ErrorMap

function access(
  permission: PlanetPermission,
): MetaPlugin<InitialInputSchema, InitialOutputSchema, typeof PLANET_ERRORS> {
  return {
    name: '~planet-access',
    init: (meta: Meta): Meta => ({
      ...meta,
      '~planet-access': { permission } satisfies PlanetAccessMetadata,
    }),
  }
}

function isPlanetAccessMetadata(value: unknown): value is PlanetAccessMetadata {
  return typeof value === 'object'
    && value !== null
    && 'permission' in value
    && (value.permission === 'planets.read' || value.permission === 'planets.write')
}

export function planetContext(
  tenantId: string,
  actorId: string,
  role: PlanetRole,
): PlanetRequestContext {
  return {
    tenantId,
    actorId,
    role,
    permissions: new Set<PlanetPermission>(role === 'admin'
      ? ['planets.read', 'planets.write']
      : ['planets.read']),
  }
}

export function createPlanetSaaSExample(): PlanetSaaSExample {
  const planets = new Map<string, Planet>()
  const base = os.$context<PlanetRequestContext>().errors(PLANET_ERRORS)

  const listPlanets = base
    .meta(access('planets.read'))
    .meta(mcp.tool({ description: 'List planets in the current tenant', annotations: { readOnlyHint: true } }))
    .handler(({ context }) => [...planets.values()].filter(planet => planet.tenantId === context.tenantId))

  const createPlanet = base
    .meta(access('planets.write'))
    .meta(mcp.tool({ description: 'Create a planet in the current tenant' }))
    .input(z.object({ id: z.string(), name: z.string() }))
    .handler(({ context, input }) => {
      const planet: Planet = {
        ...input,
        tenantId: context.tenantId,
        createdBy: context.actorId,
      }
      planets.set(planet.id, planet)
      return planet
    })

  const readPlanet = base
    .meta(access('planets.read'))
    .meta(mcp.resource({ uriTemplate: 'planet://{id}', mimeType: 'application/json' }))
    .input(z.object({ id: z.string() }))
    .use(({ context, next, errors }, input) => {
      const planet = planets.get(input.id)
      if (planet === undefined || planet.tenantId !== context.tenantId) {
        throw errors.NOT_FOUND()
      }
      return next({ context: { planet } })
    })
    .handler(({ context }) => context.planet)

  const router = { listPlanets, createPlanet, readPlanet }
  const converters = [new ZodToJsonSchemaConverter()]
  const authorizeCatalogEntry: AuthorizeCatalogEntry<PlanetRequestContext> = ({ entry, context }) => {
    const metadata = entry.contractMeta['~planet-access']
    return isPlanetAccessMetadata(metadata)
      && context.permissions.has(metadata.permission)
  }
  const handler = new FetchMCPHandler(router, { converters, authorizeCatalogEntry })
  const nodeHandler = new NodeMCPHandler(router, { converters, authorizeCatalogEntry })

  return { handler, nodeHandler }
}
