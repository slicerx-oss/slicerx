// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// In-memory relay with the behavior the hosted relay must match (README.md, "Relay").
// Tests use it, and it doubles as the reference for the hosted implementation.
import type { RelayConnection } from './transport'

export const RELAY_LIMITS = {
  /** Largest body, in characters. */
  maxBody: 1_500_000,
  /** Bodies kept for a route with no subscriber. Older ones are dropped first. */
  queuePerRoute: 64,
  /** How long a queued body waits for a subscriber. */
  queueTtlMs: 10 * 60 * 1000,
  /** Opaque routes are exactly this long (32 bytes of base64url). */
  routeChars: 43,
} as const

export interface MemoryRelay {
  /** `accountId` stands in for a verified account session. */
  connect(opts?: { accountId?: string }): RelayConnection
  /** Every body the relay carried, for tests that check it never saw plaintext. */
  readonly log: { route: string; body: string }[]
}

const OPAQUE = /^[A-Za-z0-9_-]{43}$/

/** Opaque routes are open to anyone who knows them; `acct:<id>:...` routes need that account. */
export function routeAllowed(route: string, accountId: string | undefined): boolean {
  if (OPAQUE.test(route)) return true
  const m = /^acct:([A-Za-z0-9-]{1,64}):join(?::[A-Za-z0-9_-]{22}){0,2}$/.exec(route)
  return m !== null && accountId !== undefined && m[1] === accountId
}

export function createMemoryRelay(opts: { now?: () => number } = {}): MemoryRelay {
  const now = opts.now ?? (() => Date.now())
  const subs = new Map<string, Set<(body: string) => void>>()
  const queues = new Map<string, { body: string; at: number }[]>()
  const log: { route: string; body: string }[] = []

  function deliver(route: string, body: string): void {
    log.push({ route, body })
    const set = subs.get(route)
    if (set && set.size > 0) {
      for (const cb of [...set]) queueMicrotask(() => cb(body))
      return
    }
    const q = (queues.get(route) ?? []).filter((m) => now() - m.at < RELAY_LIMITS.queueTtlMs)
    q.push({ body, at: now() })
    while (q.length > RELAY_LIMITS.queuePerRoute) q.shift()
    queues.set(route, q)
  }

  return {
    log,
    connect({ accountId } = {}) {
      const mine = new Map<string, (body: string) => void>()
      let open = true
      return {
        subscribe(route, onBody) {
          if (!open || !routeAllowed(route, accountId)) return () => {}
          const cb = (b: string) => {
            if (open) onBody(b)
          }
          let set = subs.get(route)
          if (!set) subs.set(route, (set = new Set()))
          set.add(cb)
          mine.set(route, cb)
          const waiting = (queues.get(route) ?? []).filter((m) => now() - m.at < RELAY_LIMITS.queueTtlMs)
          queues.delete(route)
          for (const m of waiting) queueMicrotask(() => cb(m.body))
          return () => {
            subs.get(route)?.delete(cb)
            mine.delete(route)
          }
        },
        send(route, body) {
          if (!open || body.length > RELAY_LIMITS.maxBody || !routeAllowed(route, accountId)) return
          deliver(route, body)
        },
        close() {
          open = false
          for (const [route, cb] of mine) subs.get(route)?.delete(cb)
          mine.clear()
        },
      }
    },
  }
}
