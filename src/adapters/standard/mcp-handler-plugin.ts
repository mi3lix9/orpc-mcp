import type { AnyORPCError } from '@orpc/client'
import type { Context } from '@orpc/server'
import type {
  StandardHandlerHandleResult,
  StandardHandlerOptions,
  StandardHandlerPlugin,
  StandardHandlerRoutingInterceptorOptions,
} from '@orpc/server/standard'
import type { InterceptorOptions } from '@orpc/shared'
import type { StandardLazyRequest } from '@standardserver/core'
import type { AuthorizeCatalogEntry } from '../../authorization'
import type { MCPCatalogEntry } from '../../authorization'
import type { MCPRegistry, MCPRegistryProvider } from '../../registry'
import type {
  CacheHints,
  DiscoverResult,
  EnvelopeIssue,
  Implementation,
  InitializeResult,
  JSONRPCErrorObject,
  JSONRPCIncoming,
  ProtocolEra,
  ServerCapabilities,
} from '../../types'
import type { MCPCodecBody } from './mcp-handler-codec'
import { ORPCError } from '@orpc/client'
import { flattenStandardHeader } from '@standardserver/core'
import {
  DEFAULT_CACHE_SCOPE,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_SERVER_NAME,
  DEFAULT_SERVER_VERSION,
  FORBIDDEN_ERROR,
  HEADER_MISMATCH,
  INVALID_PARAMS,
  INVALID_REQUEST,
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_HEADER,
  PARSE_ERROR,
  RESOURCE_NOT_FOUND,
  SERVER_INFO_META_KEY,
  SUPPORTED_MODERN_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  UNSUPPORTED_PROTOCOL_VERSION,
} from '../../constants'
import { encodePromptMessages, encodeResourceContents, encodeToolResult } from '../../content'
import { toJSONRPCError } from '../../error'
import {
  decodeStandardHeaderValue,
  envelopeClaimVersion,
  hasEnvelopeClaim,
  isModernProtocolVersion,
  MCP_NAME_HEADER_SOURCE,
  requestMetaOf,
  validateEnvelopeMeta,
} from '../../protocol-era'
import { resolveCatalogEntry } from './resolve-catalog-entry'
import { isObject, isValidIncoming, withResolvedBody } from './utils'

/**
 * Methods dispatched through the oRPC procedure pipeline rather than answered
 * inline. Every table here is keyed by a peer-controlled method string, so
 * lookups MUST use `Object.hasOwn` — `'constructor' in table` is true.
 */
const PROCEDURE_METHODS: Record<string, true> = {
  'tools/call': true,
  'resources/read': true,
  'prompts/get': true,
}

/**
 * Methods whose modern-era result carries the required `ttlMs`/`cacheScope`
 * cache hints (SEP-2549). Everything else is uncacheable by omission.
 */
const CACHEABLE_METHODS: Record<string, true> = {
  'tools/list': true,
  'resources/list': true,
  'resources/templates/list': true,
  'prompts/list': true,
  'resources/read': true,
  'server/discover': true,
}

/** Methods that exist only on the legacy era — the modern era deleted them. */
const LEGACY_ONLY_METHODS: Record<string, true> = {
  initialize: true,
  ping: true,
}

/** The era a single request was classified into, plus the revision it named. */
type Classification
  = | { era: 'legacy' }
    | { era: 'modern', revision: string }

export interface MCPHandlerPluginOptions<T extends Context> {
  /** Server identity reported during `initialize` and in modern result `_meta`. */
  serverInfo?: Partial<Implementation>
  /** Optional `instructions` returned to the client by `initialize`/`server/discover`. */
  instructions?: string
  /**
   * Request-local visibility gate for MCP catalog discovery and invocation.
   * Ordinary oRPC middleware remains the final authorization boundary.
   */
  authorizeCatalogEntry?: AuthorizeCatalogEntry<T>
  /**
   * Enable Origin/Host validation (DNS-rebinding protection) for HTTP transports.
   * A missing `Origin` header always passes (non-browser clients). When enabled,
   * a present `Origin`/`Host` not in the corresponding allowlist is rejected (403).
   *
   * @default false
   */
  enableDnsRebindingProtection?: boolean
  /** Allowed `Origin` header values (exact match) when protection is enabled. */
  allowedOrigins?: string[]
  /** Allowed `Host` header values (exact match) when protection is enabled. */
  allowedHosts?: string[]
  /**
   * Page size for catalog pagination of the `list` methods (`tools/list`,
   * `resources/list`, `resources/templates/list`, `prompts/list`). Catalogs at
   * or under this size return a single page.
   *
   * @default 100
   */
  pageSize?: number
  /**
   * Cache hints stamped onto cacheable modern-era results — the `list` methods,
   * `resources/read` and `server/discover` — where both fields are required.
   *
   * Defaults to `{ ttlMs: 0, cacheScope: 'private' }`: never reuse, never share
   * across authorization contexts. Raise `ttlMs` only for catalogs that are
   * genuinely stable, and set `cacheScope: 'public'` only when the payload
   * holds no per-user data — a shared gateway may serve a `public` result to a
   * different caller.
   */
  cache?: Partial<CacheHints>
  /**
   * Which transport this plugin is serving.
   *
   * The SEP-2243 standard request headers (`Mcp-Method`/`Mcp-Name`) are a
   * Streamable-HTTP-only requirement; stdio has no header layer, so requiring
   * them there would reject every valid modern stdio message. Adapters set
   * this — callers do not need to.
   *
   * @default 'http'
   */
  transport?: 'http' | 'stdio'
}

/**
 * Auto-registered plugin that turns a {@link StandardHandler} into an MCP server
 * speaking both protocol eras from one endpoint.
 *
 * Each request is classified independently, body-primary: a request carrying the
 * reserved `_meta` envelope is **modern** (2026-07-28 — stateless, no handshake),
 * anything else is **legacy** (2024-10-07 … 2025-11-25 — the `initialize`
 * handshake). Nothing is remembered between requests, which is what lets any
 * request land on any instance behind a plain load balancer.
 *
 * It installs a routing interceptor that owns the JSON-RPC envelope:
 * - protocol methods (`initialize`, `ping`, `server/discover`, the `list`
 *   methods) are answered with an early response (no procedure call);
 * - procedure methods (`tools/call`, `resources/read`, `prompts/get`) fall
 *   through to {@link MCPHandlerCodec} via `next()` (the standard procedure
 *   pipeline), then this plugin shapes the MCP result and frames the JSON-RPC
 *   envelope with the request `id`.
 */
export class MCPHandlerPlugin<T extends Context> implements StandardHandlerPlugin<T> {
  readonly name = '~mcp'

  private readonly serverInfo: Implementation
  private readonly instructions: string | undefined
  private readonly enableDnsRebindingProtection: boolean
  private readonly allowedOrigins: string[] | undefined
  private readonly allowedHosts: string[] | undefined
  private readonly pageSize: number
  private readonly cache: CacheHints
  private readonly checksStandardHeaders: boolean
  private readonly authorizeCatalogEntry: AuthorizeCatalogEntry<T> | undefined

  constructor(
    private readonly registry: MCPRegistryProvider,
    options: MCPHandlerPluginOptions<T> = {},
  ) {
    this.serverInfo = {
      name: options.serverInfo?.name ?? DEFAULT_SERVER_NAME,
      version: options.serverInfo?.version ?? DEFAULT_SERVER_VERSION,
      ...(options.serverInfo?.title !== undefined ? { title: options.serverInfo.title } : {}),
    }
    this.instructions = options.instructions
    this.authorizeCatalogEntry = options.authorizeCatalogEntry
    this.enableDnsRebindingProtection = options.enableDnsRebindingProtection ?? false
    this.allowedOrigins = options.allowedOrigins
    this.allowedHosts = options.allowedHosts
    // Fail loud on a no-op security config: enabling protection without any
    // allowlist would otherwise silently allow every Origin/Host.
    if (this.enableDnsRebindingProtection && this.allowedOrigins === undefined && this.allowedHosts === undefined) {
      throw new TypeError('`enableDnsRebindingProtection` requires `allowedOrigins` and/or `allowedHosts` to be set.')
    }
    this.pageSize = options.pageSize !== undefined && Number.isInteger(options.pageSize) && options.pageSize > 0
      ? options.pageSize
      : DEFAULT_LIST_PAGE_SIZE
    const ttlMs = options.cache?.ttlMs
    this.cache = {
      ttlMs: ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_CACHE_TTL_MS,
      cacheScope: options.cache?.cacheScope ?? DEFAULT_CACHE_SCOPE,
    }
    this.checksStandardHeaders = (options.transport ?? 'http') === 'http'
  }

  init(options: StandardHandlerOptions<T>): StandardHandlerOptions<T> {
    return {
      ...options,
      routingInterceptors: [
        ...(options.routingInterceptors ?? []),
        interceptorOptions => this.route(interceptorOptions),
      ],
    }
  }

  private async route(
    options: InterceptorOptions<StandardHandlerRoutingInterceptorOptions<T>, Promise<StandardHandlerHandleResult>>,
  ): Promise<StandardHandlerHandleResult> {
    const { request, next } = options

    // 1. DNS-rebinding / Origin protection (no-op for stdio / non-browser clients).
    if (!this.checkSecurity(request)) {
      return jsonRpc(403, null, { error: { code: FORBIDDEN_ERROR, message: 'Origin not allowed' } })
    }

    // 2. MCP uses HTTP POST. The modern era has no GET stream and no session to
    //    DELETE, and the legacy SSE/session transports were never implemented.
    if (request.method !== 'POST') {
      return { matched: true, response: { status: 405, headers: { allow: 'POST' }, body: undefined } }
    }

    // 3. Parse the JSON-RPC envelope (single body read for the whole pipeline).
    let payload: unknown
    try {
      payload = await request.resolveBody('json')
    }
    catch {
      return jsonRpc(400, null, { error: { code: PARSE_ERROR, message: 'Parse error' } })
    }

    // 4. Batching is unsupported: it is incompatible with the standard
    //    one-request/one-procedure flow, was removed from the spec in 2025-06-18,
    //    and a modern request is a single-message POST by construction.
    if (Array.isArray(payload)) {
      return jsonRpc(400, null, { error: { code: INVALID_REQUEST, message: 'JSON-RPC batching is not supported' } })
    }

    if (!isValidIncoming(payload)) {
      return jsonRpc(400, null, { error: { code: INVALID_REQUEST, message: 'Invalid Request' } })
    }

    const id = 'id' in payload ? payload.id : undefined

    // 5. Classify the era from this request alone. Notifications are classified
    //    too — a malformed envelope on one is still a bad request — so this runs
    //    before the notification acknowledgement below.
    const classified = this.classify(request, payload, id ?? null)
    if ('matched' in classified) {
      return classified
    }

    // 6. Notification (no id) — acknowledge with 202, no body.
    if (id === undefined) {
      return { matched: true, response: { status: 202, headers: {}, body: undefined } }
    }

    // 7. SEP-2243 standard request headers: required on modern HTTP requests,
    //    and cross-checked against the body they mirror.
    if (classified.era === 'modern' && this.checksStandardHeaders) {
      const mismatch = this.validateStandardHeaders(request, payload)
      if (mismatch !== undefined) {
        return jsonRpc(400, id, { error: mismatch })
      }
    }

    // 8. Procedure methods → standard pipeline via the codec, then frame. The
    //    codec re-reads the body to resolve its procedure; hand it a request
    //    with the parse already baked in so it shares this single read.
    //    Procedure errors are resolved by the codec (as an `MCPCodecBody`), not
    if (Object.hasOwn(PROCEDURE_METHODS, payload.method)) {
      const params = isObject(payload.params) ? payload.params : {}
      const authorize = this.authorizeCatalogEntry
      if (authorize !== undefined) {
        const resolved = resolveCatalogEntry(payload.method, params, await this.registry.get())
        if (resolved !== undefined) {
          const allowed = await authorize({
            entry: resolved.entry,
            operation: 'invoke',
            context: options.context,
            request,
            params,
          })
          if (!allowed) {
            return jsonRpc(200, id, { error: this.notFound(payload.method, params) })
          }
        }
      }
      return this.frameProcedure(
        payload,
        id,
        classified.era,
        () => next({ ...options, request: withResolvedBody(request, payload) }),
      )
    }

    // 9. Protocol methods → early response. These throw `ORPCError` on failure
    //    (unknown method, bad cursor); map to a JSON-RPC error at this boundary.
    try {
      const result = await this.handleProtocol(payload, classified.era, options)
      return jsonRpc(200, id, { result: this.finalizeResult(payload.method, classified.era, result) })
    }
    catch (error) {
      return jsonRpc(200, id, { error: toJSONRPCError(error) })
    }
  }

  /**
   * Decide which era a single message belongs to, body-primary.
   *
   * Returns a ready response instead of a classification when the message is
   * self-contradictory: a malformed envelope (`-32602`), an unsupported
   * revision (`-32022`), or headers that disagree with the body (`-32020`).
   */
  private classify(
    request: StandardLazyRequest,
    payload: JSONRPCIncoming,
    id: string | number | null,
  ): Classification | StandardHandlerHandleResult {
    const params = payload.params
    const headerVersion = this.checksStandardHeaders
      ? flattenStandardHeader(request.headers[MCP_PROTOCOL_VERSION_HEADER])
      : undefined
    const headerNamesModern = headerVersion !== undefined && isModernProtocolVersion(headerVersion)
    const claimed = hasEnvelopeClaim(params)

    // `initialize` IS the legacy handshake. Only a well-formed modern envelope
    // overrides that, in which case the modern era answers it like any other
    // method it does not define (method not found).
    if (payload.method === 'initialize' && !this.carriesValidModernClaim(params)) {
      if (headerNamesModern) {
        return jsonRpc(400, id, {
          error: headerMismatch(
            headerVersion,
            `an initialize request (the legacy handshake) carried a modern MCP-Protocol-Version header (${headerVersion})`,
          ),
        })
      }
      return { era: 'legacy' }
    }

    if (claimed) {
      // A present claim is validated, never silently ignored: a malformed
      // envelope behind it is an invalid-params rejection naming the offending
      // key, not a fall back to legacy handling.
      const issue = validateEnvelopeMeta(requestMetaOf(params))[0]
      if (issue !== undefined) {
        return jsonRpc(400, id, { error: envelopeInvalid(issue) })
      }

      // Guaranteed a string: an absent or non-string claim is an issue above.
      const revision = envelopeClaimVersion(params) as string

      if (headerVersion !== undefined && headerVersion !== revision) {
        return jsonRpc(400, id, {
          error: headerMismatch(
            headerVersion,
            `the body envelope names protocol version ${revision} but the MCP-Protocol-Version header names ${headerVersion}`,
          ),
        })
      }

      if (!(SUPPORTED_MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(revision)) {
        return jsonRpc(400, id, {
          error: {
            code: UNSUPPORTED_PROTOCOL_VERSION,
            message: `Unsupported protocol version: ${revision}`,
            data: { supported: [...SUPPORTED_MODERN_PROTOCOL_VERSIONS], requested: revision },
          },
        })
      }

      return { era: 'modern', revision }
    }

    // No claim. A header naming a modern revision does NOT promote the request:
    // the modern era carries its metadata in the envelope, so a request without
    // one is missing required params.
    if (headerNamesModern) {
      const missing = validateEnvelopeMeta(requestMetaOf(params))
        .filter(candidate => candidate.problem === 'missing')
        .map(candidate => candidate.key)
      return jsonRpc(400, id, {
        error: {
          code: INVALID_PARAMS,
          message: `Invalid params: the MCP-Protocol-Version header names protocol revision ${headerVersion}, `
            + `but the request is missing the required per-request envelope key(s): ${missing.join(', ')}`,
          data: { envelope: { missing } },
        },
      })
    }

    return { era: 'legacy' }
  }

  /** Whether params carry an envelope that is both valid and names a modern revision. */
  private carriesValidModernClaim(params: unknown): boolean {
    if (!hasEnvelopeClaim(params)) {
      return false
    }
    const revision = envelopeClaimVersion(params)
    if (revision === undefined || !isModernProtocolVersion(revision)) {
      return false
    }
    return validateEnvelopeMeta(requestMetaOf(params)).length === 0
  }

  /**
   * Validate the SEP-2243 standard request headers against the body they
   * mirror. `Mcp-Method` is required on every modern request; `Mcp-Name` is
   * required for the three methods that carry a name/uri the header mirrors.
   */
  private validateStandardHeaders(request: StandardLazyRequest, payload: JSONRPCIncoming): JSONRPCErrorObject | undefined {
    const method = payload.method
    const methodHeader = flattenStandardHeader(request.headers[MCP_METHOD_HEADER])

    if (methodHeader === undefined) {
      return headerMismatch('(missing)', `the body names method ${method} but the required Mcp-Method header is absent`)
    }
    if (methodHeader !== method) {
      return headerMismatch(methodHeader, `the body names method ${method} but the Mcp-Method header names ${methodHeader}`)
    }

    // Guard the lookup against `Object.prototype` keys — `method` is peer-controlled.
    const sourceField = Object.hasOwn(MCP_NAME_HEADER_SOURCE, method) ? MCP_NAME_HEADER_SOURCE[method] : undefined
    if (sourceField === undefined) {
      return undefined
    }

    const params = isObject(payload.params) ? payload.params : {}
    const sourceValue = params[sourceField]
    const bodyValue = typeof sourceValue === 'string' ? sourceValue : undefined
    const nameHeader = flattenStandardHeader(request.headers[MCP_NAME_HEADER])

    if (nameHeader === undefined) {
      // A body with no `params.name`/`params.uri` at all is a params failure
      // resolved further down; this check only answers the absent-header case.
      if (bodyValue === undefined) {
        return undefined
      }
      return headerMismatch(
        '(missing)',
        `the body carries params.${sourceField}="${bodyValue}" but the required Mcp-Name header is absent`,
      )
    }

    const decoded = decodeStandardHeaderValue(nameHeader)
    if (decoded === undefined) {
      return headerMismatch(nameHeader, 'the Mcp-Name header carries an invalid Base64 sentinel value')
    }
    if (bodyValue !== undefined && decoded !== bodyValue) {
      return headerMismatch(
        nameHeader,
        `the body carries params.${sourceField}="${bodyValue}" but the Mcp-Name header names "${decoded}"`,
      )
    }

    return undefined
  }

  private async frameProcedure(
    message: JSONRPCIncoming,
    id: string | number,
    era: ProtocolEra,
    next: () => Promise<StandardHandlerHandleResult>,
  ): Promise<StandardHandlerHandleResult> {
    const result = await next()
    const params = isObject(message.params) ? message.params : {}

    if (!result.matched) {
      return jsonRpc(200, id, { error: this.notFound(message.method, params) })
    }

    const codecBody = result.response.body as unknown as MCPCodecBody
    const registry = await this.registry.get()

    if (codecBody.kind === 'error') {
      const error = codecBody.error as AnyORPCError
      // Tool errors are reported in-band (so the model can react); resource and
      // prompt errors are protocol-level JSON-RPC errors.
      if (message.method === 'tools/call') {
        const failure = { content: [{ type: 'text', text: error.message }], isError: true }
        return jsonRpc(200, id, { result: this.finalizeResult(message.method, era, failure) })
      }
      return jsonRpc(200, id, { error: toJSONRPCError(error) })
    }

    const shaped = this.shapeProcedureResult(message.method, params, codecBody.output, registry)
    return jsonRpc(200, id, { result: this.finalizeResult(message.method, era, shaped) })
  }

  /**
   * Apply the era's result envelope. The modern era requires `resultType` on
   * every result and cache hints on the cacheable ones, and asks servers to
   * report their identity in `_meta`; the legacy era has none of that
   * vocabulary, so its results pass through untouched.
   */
  private finalizeResult(method: string, era: ProtocolEra, result: unknown): unknown {
    if (era === 'legacy' || !isObject(result)) {
      return result
    }

    const existingMeta = isObject(result._meta) ? result._meta : undefined
    return {
      resultType: 'complete',
      ...result,
      ...(Object.hasOwn(CACHEABLE_METHODS, method) ? this.cache : {}),
      _meta: { ...existingMeta, [SERVER_INFO_META_KEY]: this.serverInfo },
    }
  }

  private shapeProcedureResult(method: string, params: Record<string, unknown>, output: unknown, registry: MCPRegistry): unknown {
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : ''
      const hasOutputSchema = registry.tools.get(name)?.definition.outputSchema !== undefined
      return encodeToolResult(output, hasOutputSchema)
    }
    if (method === 'resources/read') {
      const uri = typeof params.uri === 'string' ? params.uri : ''
      return { contents: encodeResourceContents(output, uri, this.resourceMimeType(uri, registry)) }
    }
    // prompts/get
    const name = typeof params.name === 'string' ? params.name : ''
    const description = registry.prompts.get(name)?.meta.description
    const result = encodePromptMessages(output)
    return description !== undefined && result.description === undefined ? { description, ...result } : result
  }

  private resourceMimeType(uri: string, registry: MCPRegistry): string | undefined {
    const staticEntry = registry.resources.get(uri)
    if (staticEntry !== undefined) {
      return staticEntry.meta.mimeType
    }
    for (const entry of registry.resourceTemplates) {
      if (entry.template.match(uri) !== undefined) {
        return entry.meta.mimeType
      }
    }
    return undefined
  }

  private notFound(method: string, params: Record<string, unknown>): JSONRPCErrorObject {
    if (method === 'resources/read') {
      // A malformed request (missing/non-string uri) is invalid params, not a
      // "resource not found"; reserve -32002 for syntactically valid URIs.
      if (typeof params.uri !== 'string') {
        return { code: INVALID_PARAMS, message: 'resources/read requires a string "uri"' }
      }
      return { code: RESOURCE_NOT_FOUND, message: `Resource not found: ${params.uri}`, data: { uri: params.uri } }
    }
    const kind = method === 'prompts/get' ? 'prompt' : 'tool'
    return { code: INVALID_PARAMS, message: `Unknown ${kind}: ${String(params.name)}` }
  }

  /** Apply opaque-cursor catalog pagination to a list result. */
  private paginate(items: unknown[], key: string, cursor: unknown): Record<string, unknown> {
    const offset = decodeCursor(cursor)
    // A valid cursor always points within the catalog (nextCursor is only emitted
    // when more items remain), so an out-of-range offset is a stale/invalid cursor.
    if (offset > 0 && offset >= items.length) {
      throw new ORPCError('INVALID_PARAMS', { message: 'Invalid cursor' })
    }
    const page = items.slice(offset, offset + this.pageSize)
    const result: Record<string, unknown> = { [key]: page }
    if (offset + this.pageSize < items.length) {
      result.nextCursor = encodeCursor(offset + this.pageSize)
    }
    return result
  }

  private async handleProtocol(
    message: JSONRPCIncoming,
    era: ProtocolEra,
    options: StandardHandlerRoutingInterceptorOptions<T>,
  ): Promise<unknown> {
    const params = isObject(message.params) ? message.params : {}
    const method = message.method

    // Era-scoped vocabulary. The modern era deleted `initialize` and `ping`;
    // `server/discover` exists only there. A method outside its own era is
    // answered exactly like one that does not exist at all.
    if (era === 'modern' ? Object.hasOwn(LEGACY_ONLY_METHODS, method) : method === 'server/discover') {
      throw new ORPCError('METHOD_NOT_FOUND', { message: `Method not found: ${method}` })
    }

    switch (method) {
      case 'initialize':
        return this.initialize(params, options)
      case 'ping':
        return {}
      case 'server/discover':
        return this.discover(options)
      case 'tools/list': {
        const entries = await this.authorizedEntries([...(await this.registry.get()).tools.values()], options)
        return this.paginate(entries.map(entry => entry.definition), 'tools', params.cursor)
      }
      case 'resources/list': {
        const entries = await this.authorizedEntries([...(await this.registry.get()).resources.values()], options)
        return this.paginate(entries.map(entry => entry.definition), 'resources', params.cursor)
      }
      case 'resources/templates/list': {
        const entries = await this.authorizedEntries((await this.registry.get()).resourceTemplates, options)
        return this.paginate(entries.map(entry => entry.definition), 'resourceTemplates', params.cursor)
      }
      case 'prompts/list': {
        const entries = await this.authorizedEntries([...(await this.registry.get()).prompts.values()], options)
        return this.paginate(entries.map(entry => entry.definition), 'prompts', params.cursor)
      }
      default:
        throw new ORPCError('METHOD_NOT_FOUND', { message: `Method not found: ${method}` })
    }
  }

  private async authorizedEntries<E extends MCPCatalogEntry>(
    entries: readonly E[],
    options: StandardHandlerRoutingInterceptorOptions<T>,
  ): Promise<E[]> {
    const authorize = this.authorizeCatalogEntry
    if (authorize === undefined) {
      return [...entries]
    }

    const decisions = await Promise.all(entries.map(entry =>
      authorize({
        entry,
        operation: 'discover',
        context: options.context,
        request: options.request,
      }),
    ))
    return entries.filter((_, index) => decisions[index])
  }

  /**
   * Answer `server/discover`, the modern era's capability advertisement. It
   * only ever offers modern revisions — a legacy revision here would be a
   * version a modern client cannot actually speak.
   */
  private async discover(
    options: StandardHandlerRoutingInterceptorOptions<T>,
  ): Promise<Omit<DiscoverResult, 'resultType' | keyof CacheHints>> {
    return {
      supportedVersions: [...SUPPORTED_MODERN_PROTOCOL_VERSIONS],
      capabilities: await this.capabilities(options),
      ...(this.instructions !== undefined ? { instructions: this.instructions } : {}),
    }
  }

  private async initialize(params: Record<string, unknown>, options: StandardHandlerRoutingInterceptorOptions<T>): Promise<InitializeResult> {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
    // Legacy negotiation only ever consults the legacy list, so a modern
    // revision can never be accepted or counter-offered by the handshake.
    const protocolVersion = requested !== undefined && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION

    return {
      protocolVersion,
      capabilities: await this.capabilities(options),
      serverInfo: this.serverInfo,
      ...(this.instructions !== undefined ? { instructions: this.instructions } : {}),
    }
  }

  /** What this server can do, derived from the request-authorized catalog. */
  private async capabilities(options: StandardHandlerRoutingInterceptorOptions<T>): Promise<ServerCapabilities> {
    const registry = await this.registry.get()
    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
      this.authorizedEntries([...registry.tools.values()], options),
      this.authorizedEntries([...registry.resources.values()], options),
      this.authorizedEntries(registry.resourceTemplates, options),
      this.authorizedEntries([...registry.prompts.values()], options),
    ])
    const capabilities: ServerCapabilities = {}
    if (tools.length > 0) {
      capabilities.tools = { listChanged: false }
    }
    if (resources.length > 0 || resourceTemplates.length > 0) {
      capabilities.resources = { subscribe: false, listChanged: false }
    }
    if (prompts.length > 0) {
      capabilities.prompts = { listChanged: false }
    }
    return capabilities
  }

  private checkSecurity(request: StandardLazyRequest): boolean {
    if (!this.enableDnsRebindingProtection) {
      return true
    }

    const origin = flattenStandardHeader(request.headers.origin)
    if (origin !== undefined && this.allowedOrigins !== undefined && !this.allowedOrigins.includes(origin)) {
      return false
    }

    const host = flattenStandardHeader(request.headers.host)
    if (host !== undefined && this.allowedHosts !== undefined && !this.allowedHosts.includes(host)) {
      return false
    }

    return true
  }
}

/** A `-32020` header/body disagreement, carrying both sides for diagnosis. */
function headerMismatch(header: string, body: string): JSONRPCErrorObject {
  return {
    code: HEADER_MISMATCH,
    message: `Bad Request: the request headers and body disagree: ${body}`,
    data: { mismatch: { header, body } },
  }
}

/** A `-32602` rejection naming the offending `_meta` envelope key. */
function envelopeInvalid(issue: EnvelopeIssue): JSONRPCErrorObject {
  return {
    code: INVALID_PARAMS,
    message: `Invalid _meta envelope for protocol revision 2026-07-28: ${issue.key}: ${issue.problem}`,
    data: { envelope: issue },
  }
}

/** Opaque, offset-based pagination cursor (the registry order is deterministic). */
function encodeCursor(offset: number): string {
  return btoa(String(offset))
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null) {
    return 0
  }
  if (typeof cursor !== 'string') {
    throw new ORPCError('INVALID_PARAMS', { message: 'Invalid cursor' })
  }
  let decoded: string
  try {
    decoded = atob(cursor)
  }
  catch {
    throw new ORPCError('INVALID_PARAMS', { message: 'Invalid cursor' })
  }
  const offset = Number(decoded)
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ORPCError('INVALID_PARAMS', { message: 'Invalid cursor' })
  }
  return offset
}

function jsonRpc(
  status: number,
  id: string | number | null,
  payload: { result: unknown } | { error: JSONRPCErrorObject },
): StandardHandlerHandleResult {
  return {
    matched: true,
    response: {
      status,
      headers: {},
      body: { jsonrpc: JSONRPC_VERSION, id, ...payload } as never,
    },
  }
}
