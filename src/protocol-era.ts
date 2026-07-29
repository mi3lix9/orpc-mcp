/**
 * Protocol-era helpers (pure module).
 *
 * The MCP wire protocol splits into two eras:
 *
 * - **legacy** — `2024-10-07` … `2025-11-25`. Opens with the `initialize`
 *   handshake; the negotiated revision governs the connection.
 * - **modern** — `2026-07-28` and later. No handshake and no session: every
 *   request is self-describing, carrying its protocol revision and the client's
 *   capabilities in a reserved `_meta` envelope, and servers advertise
 *   themselves via `server/discover`.
 *
 * Classification is **body-primary**: the `_meta` envelope decides the era and
 * HTTP headers are only ever cross-checks, so a request can never be promoted
 * to the modern era by a header alone.
 */

import type { EnvelopeIssue, RequestMetaObject } from './types'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  FIRST_MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
} from './constants'

/** The reserved `_meta` keys a modern-era request MUST carry, in reporting order. */
const REQUIRED_ENVELOPE_KEYS = [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a protocol revision belongs to the modern era. Revision identifiers
 * are ISO dates, so a lexicographic compare orders them chronologically — no
 * lookup table, and an unreleased future revision still classifies correctly.
 */
export function isModernProtocolVersion(version: string): boolean {
  return version >= FIRST_MODERN_PROTOCOL_VERSION
}

/** A message's `params._meta` object, when it is present and an object. */
export function requestMetaOf(params: unknown): RequestMetaObject | undefined {
  if (!isPlainObject(params)) {
    return undefined
  }
  const meta = params._meta
  return isPlainObject(meta) ? meta as RequestMetaObject : undefined
}

/**
 * Whether a message's params carry a per-request envelope *claim* — the
 * protocol-version key being present at all, whatever its value.
 *
 * Presence alone selects the modern era, so a malformed value surfaces as a
 * validation error instead of silently falling back to legacy handling.
 */
export function hasEnvelopeClaim(params: unknown): boolean {
  const meta = requestMetaOf(params)
  return meta !== undefined && PROTOCOL_VERSION_META_KEY in meta
}

/**
 * The revision named by a request's envelope claim, when the claim carries a
 * string. A present-but-non-string claim still counts as a claim
 * ({@link hasEnvelopeClaim}); it surfaces as an {@link EnvelopeIssue} instead.
 */
export function envelopeClaimVersion(params: unknown): string | undefined {
  const value = requestMetaOf(params)?.[PROTOCOL_VERSION_META_KEY]
  return typeof value === 'string' ? value : undefined
}

/**
 * Validate a modern-era `_meta` envelope, returning every problem found (an
 * empty array means valid).
 *
 * `clientInfo` is deliberately not required — the specification demotes it to
 * SHOULD — but a present value must still be a well-formed `Implementation`.
 */
export function validateEnvelopeMeta(meta: RequestMetaObject | undefined): EnvelopeIssue[] {
  if (meta === undefined) {
    return [{ key: '_meta', problem: 'missing' }]
  }

  const issues: EnvelopeIssue[] = []

  for (const key of REQUIRED_ENVELOPE_KEYS) {
    if (!(key in meta)) {
      issues.push({ key, problem: 'missing' })
    }
  }

  const version = meta[PROTOCOL_VERSION_META_KEY]
  if (version !== undefined && typeof version !== 'string') {
    issues.push({ key: PROTOCOL_VERSION_META_KEY, problem: 'expected a protocol version string' })
  }

  const capabilities = meta[CLIENT_CAPABILITIES_META_KEY]
  if (capabilities !== undefined && !isPlainObject(capabilities)) {
    issues.push({ key: CLIENT_CAPABILITIES_META_KEY, problem: 'expected an object' })
  }

  const clientInfo = meta[CLIENT_INFO_META_KEY]
  if (clientInfo !== undefined) {
    if (!isPlainObject(clientInfo)) {
      issues.push({ key: CLIENT_INFO_META_KEY, problem: 'expected an object' })
    }
    else if (typeof clientInfo.name !== 'string' || typeof clientInfo.version !== 'string') {
      issues.push({ key: CLIENT_INFO_META_KEY, problem: 'expected `name` and `version` strings' })
    }
  }

  return issues
}

/**
 * Which body field the `Mcp-Name` header mirrors, per method (SEP-2243). A
 * method absent from this table never carries `Mcp-Name`.
 */
export const MCP_NAME_HEADER_SOURCE: Readonly<Record<string, 'name' | 'uri'>> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}

const BASE64_SENTINEL_PREFIX = '=?base64?'
const BASE64_SENTINEL_SUFFIX = '?='
const BASE64_CANONICAL = /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i

/**
 * Decode a standard-header value, resolving the `=?base64?…?=` sentinel used
 * for values that are not safe bare ASCII, and stripping RFC 9110 optional
 * whitespace first.
 *
 * Returns `undefined` when the sentinel is present but its payload is not
 * canonical base64 or not valid UTF-8 — a malformed sentinel is a header/body
 * disagreement, never a silent passthrough of the raw text.
 */
export function decodeStandardHeaderValue(value: string): string | undefined {
  let start = 0
  while (start < value.length && (value[start] === '\t' || value[start] === ' ')) {
    start++
  }
  let end = value.length
  while (end > start && (value[end - 1] === '\t' || value[end - 1] === ' ')) {
    end--
  }
  const trimmed = start === 0 && end === value.length ? value : value.slice(start, end)

  if (!(trimmed.startsWith(BASE64_SENTINEL_PREFIX) && trimmed.endsWith(BASE64_SENTINEL_SUFFIX))) {
    return trimmed
  }

  const payload = trimmed.slice(BASE64_SENTINEL_PREFIX.length, trimmed.length - BASE64_SENTINEL_SUFFIX.length)
  if (!BASE64_CANONICAL.test(payload)) {
    return undefined
  }
  try {
    // `atob` yields one byte per character; re-decode those bytes as UTF-8 so
    // non-ASCII tool names and resource URIs survive the round trip.
    const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return undefined
  }
}
