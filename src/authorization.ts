import type { Context } from '@orpc/server'
import type { Promisable } from '@orpc/shared'
import type { StandardLazyRequest } from '@standardserver/core'
import type {
  PromptEntry,
  ResourceEntry,
  ResourceTemplateEntry,
  ToolEntry,
} from './registry'

type PublicCatalogEntry<E> = Pick<E, Extract<keyof E, 'kind' | 'path' | 'name' | 'definition' | 'meta' | 'contractMeta'>>

export type MCPCatalogEntry
  = | PublicCatalogEntry<ToolEntry>
    | PublicCatalogEntry<ResourceEntry>
    | PublicCatalogEntry<ResourceTemplateEntry>
    | PublicCatalogEntry<PromptEntry>

export type MCPCatalogOperation = 'discover' | 'invoke'

export interface AuthorizeCatalogEntryOptions<T extends Context> {
  entry: MCPCatalogEntry
  operation: MCPCatalogOperation
  context: T
  request: StandardLazyRequest
  params?: Record<string, unknown>
}

export type AuthorizeCatalogEntry<T extends Context> = (
  options: AuthorizeCatalogEntryOptions<T>,
) => Promisable<boolean>
