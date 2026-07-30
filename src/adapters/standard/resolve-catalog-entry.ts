import type { MCPRegistry, MCPRegistryEntry } from '../../registry'
import { isObject } from './utils'

export interface ResolvedCatalogEntry {
  entry: MCPRegistryEntry
  input: Record<string, unknown>
}

export function resolveCatalogEntry(
  method: string,
  params: Record<string, unknown>,
  registry: MCPRegistry,
): ResolvedCatalogEntry | undefined {
  if (method === 'tools/call') {
    const entry = typeof params.name === 'string' ? registry.tools.get(params.name) : undefined
    return entry === undefined
      ? undefined
      : { entry, input: isObject(params.arguments) ? params.arguments : {} }
  }

  if (method === 'resources/read') {
    if (typeof params.uri !== 'string') {
      return undefined
    }
    const staticEntry = registry.resources.get(params.uri)
    if (staticEntry !== undefined) {
      return { entry: staticEntry, input: {} }
    }
    for (const entry of registry.resourceTemplates) {
      const variables = entry.template.match(params.uri)
      if (variables !== undefined) {
        return { entry, input: variables }
      }
    }
    return undefined
  }

  if (method === 'prompts/get') {
    const entry = typeof params.name === 'string' ? registry.prompts.get(params.name) : undefined
    return entry === undefined
      ? undefined
      : { entry, input: isObject(params.arguments) ? params.arguments : {} }
  }

  return undefined
}
