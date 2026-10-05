// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// TypeScript mirror of sx-permit for the browser demo, fleet-sim and the evals.
// The desktop app and sx-link use the Rust broker; both follow the same rules:
// tokens are HMAC-signed, bound to the request's actions, single use per
// action, and expire 5 minutes after the grant. A card can no longer be
// granted once its own expiresAt has passed (or does not parse); it is denied.
import type {
  ApprovalAction,
  ApprovalCheck,
  ApprovalHost,
  ApprovalRequest,
  ApprovalToken,
  ApprovalVerifier,
  SideEffectAction,
} from '@slicerx/contracts'
import { canonicalJson } from '@slicerx/contracts'

export const TOKEN_TTL_MS = 5 * 60 * 1000

export interface ApprovalBroker extends ApprovalHost, ApprovalVerifier {
  /** Request ids still waiting for a decision. */
  pending(): string[]
}

interface Entry {
  req: ApprovalRequest
  state: 'pending' | 'granted' | 'denied'
  used: Set<number>
  expiresMs: number
  token?: string
}

export interface BrokerOptions {
  /** Injected for deterministic tests. */
  now?: () => number
  ttlMs?: number
}

const b64url = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const validAction = (a: ApprovalAction): boolean =>
  typeof a.action === 'string' && typeof a.target === 'string' && a.target !== '' && /^[0-9a-f]{64}$/.test(a.paramsHash)

export function createApprovalBroker(opts: BrokerOptions = {}): ApprovalBroker {
  const now = opts.now ?? (() => Date.now())
  const ttl = opts.ttlMs ?? TOKEN_TTL_MS
  const entries = new Map<string, Entry>()
  const secret = globalThis.crypto.getRandomValues(new Uint8Array(32))
  let keyPromise: Promise<CryptoKey> | null = null
  const key = (): Promise<CryptoKey> =>
    (keyPromise ??= globalThis.crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']))

  async function sign(e: Entry): Promise<string> {
    const payload = canonicalJson({
      id: e.req.id,
      session: e.req.sessionId,
      tool: e.req.tool,
      params: e.req.paramsHash,
      actions: e.req.actions,
      exp: e.expiresMs,
    })
    const mac = await globalThis.crypto.subtle.sign('HMAC', await key(), new TextEncoder().encode(payload))
    return b64url(new Uint8Array(mac))
  }

  return {
    async register(req: ApprovalRequest): Promise<void> {
      if (entries.has(req.id)) throw new Error(`Approval request ${req.id} is already registered`)
      if (!Array.isArray(req.actions) || !req.actions.every(validAction)) {
        throw new Error(`Approval request ${req.id} has a malformed action list`)
      }
      // Copy so later mutation of the caller's object cannot widen the grant.
      const frozen: ApprovalRequest = structuredClone(req)
      entries.set(req.id, { req: frozen, state: 'pending', used: new Set(), expiresMs: 0 })
    },
    async grant(requestId: string): Promise<ApprovalToken> {
      const e = entries.get(requestId)
      if (!e) throw new Error(`Unknown approval request ${requestId}`)
      if (e.state !== 'pending') throw new Error(`Approval request ${requestId} was already ${e.state}`)
      const cardExpires = Date.parse(e.req.expiresAt)
      if (!Number.isFinite(cardExpires) || now() >= cardExpires) {
        e.state = 'denied'
        throw new Error(`Approval request ${requestId} expired before it was approved`)
      }
      e.state = 'granted'
      e.expiresMs = now() + ttl
      e.token = await sign(e)
      return { requestId, token: e.token, expiresAt: new Date(e.expiresMs).toISOString() }
    },
    async deny(requestId: string): Promise<void> {
      const e = entries.get(requestId)
      if (!e) return
      e.state = 'denied'
    },
    async verify(token: ApprovalToken, action: SideEffectAction, target: string, paramsHash: string): Promise<ApprovalCheck> {
      const e = token && typeof token.requestId === 'string' ? entries.get(token.requestId) : undefined
      if (!e) return { ok: false, reason: 'unknown' }
      if (e.state === 'denied') return { ok: false, reason: 'denied' }
      if (e.state !== 'granted' || !e.token) return { ok: false, reason: 'unknown' }
      if (typeof token.token !== 'string' || !sameString(token.token, e.token)) return { ok: false, reason: 'bad_signature' }
      if (now() >= e.expiresMs) return { ok: false, reason: 'expired' }
      const idx = e.req.actions.findIndex((a) => a.action === action && a.target === target && a.paramsHash === paramsHash)
      if (idx < 0) return { ok: false, reason: 'mismatch' }
      if (e.used.has(idx)) return { ok: false, reason: 'used' }
      e.used.add(idx)
      return { ok: true }
    },
    pending(): string[] {
      return [...entries.values()].filter((e) => e.state === 'pending').map((e) => e.req.id)
    },
  }
}
