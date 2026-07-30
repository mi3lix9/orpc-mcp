/**
 * The MCP protocol revision this package targets by default on the legacy
 * (`initialize`) era. Deliberately NOT the newest revision this package
 * speaks — see {@link FIRST_MODERN_PROTOCOL_VERSION}.
 */
export const LATEST_PROTOCOL_VERSION = '2025-11-25'

/**
 * Legacy-era protocol revisions this server can negotiate via `initialize`,
 * newest first.
 *
 * Modern (2026-07-28+) revisions MUST NOT appear here: `initialize` never
 * accepts or counter-offers a modern revision, so keeping the two lists
 * disjoint makes a leak structurally impossible rather than a review question.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
] as const

/**
 * The first protocol revision of the modern era. Revision identifiers are ISO
 * dates, so lexicographic comparison orders them chronologically.
 */
export const FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28'

/**
 * Modern-era protocol revisions this server advertises via `server/discover`.
 * Kept disjoint from {@link SUPPORTED_PROTOCOL_VERSIONS} on purpose.
 */
export const SUPPORTED_MODERN_PROTOCOL_VERSIONS = [
  '2026-07-28',
] as const

export const JSONRPC_VERSION = '2.0'

/** Default server identity when none is provided to the handler. */
export const DEFAULT_SERVER_NAME = 'orpc-mcp-server'
export const DEFAULT_SERVER_VERSION = '1.0.0'

/**
 * Default page size for catalog pagination (the `list` methods). Catalogs at or
 * under this size return a single page (no `nextCursor`), so small servers are
 * unaffected.
 */
export const DEFAULT_LIST_PAGE_SIZE = 100

/**
 * Default cache hints stamped onto cacheable modern-era results (`ttlMs` and
 * `cacheScope` are required fields there). `0` means "immediately stale" and
 * `private` means "never share across authorization contexts" — the pair is
 * the always-safe default, so enabling the modern era can never silently
 * publish a per-user catalog to a shared gateway cache.
 */
export const DEFAULT_CACHE_TTL_MS = 0
export const DEFAULT_CACHE_SCOPE = 'private'

// --- JSON-RPC 2.0 + MCP error codes ---
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603
/** MCP-specific: resource (or prompt) not found. */
export const RESOURCE_NOT_FOUND = -32002
/** Implementation-defined server error range (-32000 to -32099); used for rejected Origins. */
export const FORBIDDEN_ERROR = -32000

// --- reserved `_meta` envelope keys (modern era) ---

/** Carries the protocol revision governing a single request. Required. */
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'
/** Identifies the client software making a request. Clients SHOULD send it. */
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo'
/** Identifies the server software producing a result. Servers SHOULD send it. */
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo'
/** Carries the client's capabilities for a single request. Required. */
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities'

// --- SEP-2243 standard request headers (modern era, HTTP transports only) ---

export const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version'
export const MCP_METHOD_HEADER = 'mcp-method'
export const MCP_NAME_HEADER = 'mcp-name'

// --- modern-era JSON-RPC error codes ---

/** The request headers and body disagree (SEP-2243). */
export const HEADER_MISMATCH = -32020
/** A capability required to serve the request was not declared on it. */
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021
/** The requested protocol revision is not supported by this server. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022
