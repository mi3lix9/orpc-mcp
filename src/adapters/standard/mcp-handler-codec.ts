import type { AnyORPCError } from '@orpc/client'
import type { AnyProcedure, Context } from '@orpc/server'
import type { StandardHandlerCodec, StandardHandlerCodecResolvedProcedure, StandardHandlerHandleOptions } from '@orpc/server/standard'
import type { Promisable } from '@orpc/shared'
import type { StandardLazyRequest, StandardResponse } from '@standardserver/core'
import type { MCPRegistryProvider } from '../../registry'
import { resolveCatalogEntry } from './resolve-catalog-entry'
import { isObject, isValidIncoming } from './utils'

/**
 * Internal `StandardResponse.body` produced by the codec. The
 * {@link MCPHandlerPlugin} reads it back to shape the MCP result and frame the
 * JSON-RPC envelope (it owns the request `id`); this body never reaches the wire.
 */
export interface MCPCodecBody {
  kind: 'result' | 'error'
  output?: unknown
  error?: AnyORPCError
}

/**
 * `StandardHandlerCodec` for the MCP methods that invoke a procedure
 * (`tools/call`, `resources/read`, `prompts/get`). It resolves the target
 * procedure from the JSON-RPC body and hands the raw output/error back to the
 * plugin (tagged via {@link MCP_CODEC_BODY}) — the plugin shapes the MCP result
 * and frames the JSON-RPC envelope. Everything else (the actual call) goes
 * through oRPC's standard procedure pipeline.
 */
export class MCPHandlerCodec<T extends Context> implements StandardHandlerCodec<T> {
  constructor(private readonly registry: MCPRegistryProvider) {}

  async resolveProcedure(
    request: StandardLazyRequest,
    _options: StandardHandlerHandleOptions<T>,
  ): Promise<StandardHandlerCodecResolvedProcedure | undefined> {
    // The plugin already parsed + validated the envelope and handed us a
    // request with the body resolved (see `withResolvedBody`), so this is the
    // same single read, not a second consume of the stream.
    const message = await request.resolveBody('json')
    if (!isValidIncoming(message) || !('id' in message) || message.id === undefined) {
      return undefined
    }

    const params = isObject(message.params) ? message.params : {}
    const resolved = resolveCatalogEntry(message.method, params, await this.registry.get())
    if (resolved === undefined) {
      return undefined
    }
    return {
      path: [resolved.entry.name],
      procedure: resolved.entry.procedure,
      decodeInput: () => Promise.resolve(resolved.input),
    }
  }

  encodeOutput(output: unknown, _procedure: AnyProcedure, _path: string[], _options: StandardHandlerHandleOptions<T>): Promisable<StandardResponse> {
    return { status: 200, headers: {}, body: { kind: 'result', output } satisfies MCPCodecBody as never }
  }

  encodeError(error: AnyORPCError, _procedure: AnyProcedure, _path: string[], _options: StandardHandlerHandleOptions<T>): Promisable<StandardResponse> {
    return { status: 200, headers: {}, body: { kind: 'error', error } satisfies MCPCodecBody as never }
  }
}
