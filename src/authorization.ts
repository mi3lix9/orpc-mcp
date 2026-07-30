import type { Context } from '@orpc/server'
import type { Promisable } from '@orpc/shared'
import type { StandardLazyRequest } from '@standardserver/core'
import type {
  PromptEntry,
  ResourceEntry,
  ResourceTemplateEntry,
  ToolEntry,
} from './registry'

export type MCPCatalogEntry
  = | ToolEntry
    | ResourceEntry
    | ResourceTemplateEntry
    | PromptEntry

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
