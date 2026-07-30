/**
 * Minimal MCP + JSON-RPC 2.0 wire types used by the handler.
 *
 * These describe the subset of the MCP schema this package produces/consumes.
 * They are intentionally permissive (open records) so passthrough payloads from
 * procedure handlers are not rejected.
 */

// --- JSON-RPC 2.0 ---

export type JSONRPCId = string | number

export interface JSONRPCRequest {
  jsonrpc: '2.0'
  id: JSONRPCId
  method: string
  params?: Record<string, unknown> | undefined
}

export interface JSONRPCNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown> | undefined
}

export type JSONRPCIncoming = JSONRPCRequest | JSONRPCNotification

export interface JSONRPCErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JSONRPCSuccessResponse {
  jsonrpc: '2.0'
  id: JSONRPCId
  result: unknown
}

export interface JSONRPCErrorResponse {
  jsonrpc: '2.0'
  id: JSONRPCId | null
  error: JSONRPCErrorObject
}

export type JSONRPCResponse = JSONRPCSuccessResponse | JSONRPCErrorResponse

// --- MCP content ---

export interface TextContent { type: 'text', text: string, [k: string]: unknown }
export interface ImageContent { type: 'image', data: string, mimeType: string, [k: string]: unknown }
export interface AudioContent { type: 'audio', data: string, mimeType: string, [k: string]: unknown }
export interface EmbeddedResourceContent { type: 'resource', resource: ResourceContents, [k: string]: unknown }
export interface ResourceLinkContent { type: 'resource_link', uri: string, [k: string]: unknown }

export type ContentBlock
  = | TextContent
    | ImageContent
    | AudioContent
    | EmbeddedResourceContent
    | ResourceLinkContent

export interface ResourceContents {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
  [k: string]: unknown
}

// --- definitions (what `*/list` returns) ---

export interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

export interface ToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema: JsonSchemaObject
  outputSchema?: JsonSchemaObject
  annotations?: Record<string, unknown>
}

export interface ResourceDefinition {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}

export interface ResourceTemplateDefinition {
  uriTemplate: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}

export interface PromptArgument {
  name: string
  description?: string
  required?: boolean
}

export interface PromptDefinition {
  name: string
  title?: string
  description?: string
  arguments?: PromptArgument[]
}

// --- results ---

export interface CallToolResult {
  content: ContentBlock[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type PromptMessageRole = 'user' | 'assistant'

export interface PromptMessage {
  role: PromptMessageRole
  content: ContentBlock
}

export interface GetPromptResult {
  description?: string
  messages: PromptMessage[]
}

// --- lifecycle ---

export interface Implementation {
  name: string
  title?: string
  version: string
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean }
  resources?: { subscribe?: boolean, listChanged?: boolean }
  prompts?: { listChanged?: boolean }
  completions?: Record<string, unknown>
  /** @deprecated Deprecated as of protocol revision 2026-07-28 (SEP-2577). */
  logging?: Record<string, unknown>
  /**
   * Namespaced extension capabilities, keyed by reverse-DNS-style identifier
   * (`io.modelcontextprotocol` and `mcp` are reserved). Not a closed set.
   */
  extensions?: Record<string, Record<string, unknown>>
  experimental?: Record<string, Record<string, unknown>>
}

/**
 * Capabilities a client declares. On the modern era these arrive per request in
 * the `_meta` envelope rather than once at initialization — a server MUST NOT
 * infer them from a previous request.
 */
export interface ClientCapabilities {
  /** @deprecated Deprecated as of protocol revision 2026-07-28 (SEP-2577). */
  roots?: { listChanged?: boolean }
  /** @deprecated Deprecated as of protocol revision 2026-07-28 (SEP-2577). */
  sampling?: Record<string, unknown>
  elicitation?: Record<string, unknown>
  extensions?: Record<string, Record<string, unknown>>
  experimental?: Record<string, Record<string, unknown>>
}

export interface InitializeResult {
  protocolVersion: string
  capabilities: ServerCapabilities
  serverInfo: Implementation
  instructions?: string
}

// --- modern era (2026-07-28) ---

/** Which wire behavior family a message belongs to. */
export type ProtocolEra = 'legacy' | 'modern'

/**
 * The reserved per-request `_meta` envelope. `protocolVersion` and
 * `clientCapabilities` are required on every modern-era request;
 * `clientInfo` is SHOULD-send, so a server must tolerate its absence.
 */
export interface RequestMetaObject {
  'io.modelcontextprotocol/protocolVersion'?: unknown
  'io.modelcontextprotocol/clientInfo'?: unknown
  'io.modelcontextprotocol/clientCapabilities'?: unknown
  [k: string]: unknown
}

/** One problem found while validating a `_meta` envelope. */
export interface EnvelopeIssue {
  key: string
  problem: string
}

/**
 * The reserved `_meta` object on a modern-era result. Servers SHOULD report
 * their own identity on every response.
 */
export interface ResultMetaObject {
  'io.modelcontextprotocol/serverInfo'?: Implementation
  [k: string]: unknown
}

/**
 * Discriminates a result's family. `complete` is an ordinary result;
 * `input_required` is the Multi Round-Trip Request (MRTR) form. Left open
 * because the specification permits future values.
 */
export type ResultType = 'complete' | 'input_required' | (string & {})

/**
 * Cache hints required on every cacheable modern-era result (the `list`
 * methods, `resources/read` and `server/discover`).
 *
 * `ttlMs` is how long the client MAY reuse the result (`0` = immediately
 * stale). `cacheScope` is `public` when the payload holds no user-specific
 * data and MAY be shared across authorization contexts, `private` otherwise.
 */
export interface CacheHints {
  ttlMs: number
  cacheScope: 'public' | 'private'
}

/**
 * Result of `server/discover`, the modern-era replacement for `initialize`.
 *
 * Note there is no `serverInfo` field: server identity travels in `_meta`
 * under `io.modelcontextprotocol/serverInfo`, like on every other result.
 */
export interface DiscoverResult extends CacheHints {
  resultType: ResultType
  supportedVersions: string[]
  capabilities: ServerCapabilities
  instructions?: string
  _meta?: ResultMetaObject
}
