// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Relay tokens. The hosted relay's account tier takes a short-lived token minted for the relay alone
// (a JWT with audience `sx-relay`), never the account's own session, which works against the whole
// backend. The backend's `relay-token` function checks the session and mints one; this asks for it,
// keeps it until shortly before it expires, and gives null when signed out or when the exchange
// fails, so callers fall back to the anonymous tier. The minting side is described in
// packages/connect/relay/README.md, "Relay tokens".

/** The backend that mints relay tokens: the Supabase project URL and its public anon key. */
export interface RelayTokenBackend {
  url: string
  anonKey: string
}

export interface RelayTokenSourceOptions {
  backend: RelayTokenBackend
  /** The account's current session (access token), or null when signed out. */
  session: () => Promise<string | null>
  fetch?: typeof fetch
  now?: () => number
}

/** A token is asked for again this long before it expires. */
const RENEW_BEFORE_MS = 60_000

/** Returns a function that yields a relay token for the signed-in account, or null. */
export function relayTokenSource(o: RelayTokenSourceOptions): () => Promise<string | null> {
  const now = o.now ?? Date.now
  const get = o.fetch ?? fetch
  let cached: { session: string; token: string; expiresAt: number } | null = null
  return async () => {
    const session = await o.session()
    if (!session) {
      cached = null
      return null
    }
    if (cached && cached.session === session && cached.expiresAt - RENEW_BEFORE_MS > now()) return cached.token
    try {
      const res = await get(`${o.backend.url.replace(/\/+$/, '')}/functions/v1/relay-token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session}`, apikey: o.backend.anonKey },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { token?: unknown; expiresAt?: unknown }
      if (typeof body.token !== 'string' || typeof body.expiresAt !== 'number' || !relayAudience(body.token)) return null
      cached = { session, token: body.token, expiresAt: body.expiresAt }
      return body.token
    } catch {
      return null
    }
  }
}

/** True when a JWT's audience is the relay alone. A session token must never be passed on as one. */
export function relayAudience(token: string): boolean {
  const part = token.split('.')[1]
  if (!part) return false
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4))) as { aud?: unknown }
    return json.aud === 'sx-relay' || (Array.isArray(json.aud) && json.aud.length === 1 && json.aud[0] === 'sx-relay')
  } catch {
    return false
  }
}
