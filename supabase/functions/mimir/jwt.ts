// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Supabase session token, checked against the project's published signing keys
// (auth/v1/.well-known/jwks.json). Only a signed-in, non-anonymous user of this project
// passes; the user's id is what the web edition's caps are keyed by.
type Obj = Record<string, unknown>
type Jwk = JsonWebKey & { kid?: string; alg?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// a key set is kept this long; an unknown kid fetches again, at most once a minute
const KEEP_MS = 600_000
const RETRY_MS = 60_000
// clock skew allowed on exp and nbf
const SKEW_S = 30

export type JwtResult = { ok: true; user: string } | { ok: false; reason: 'missing' | 'malformed' | 'signature' | 'expired' | 'project' | 'anonymous' }

// An ArrayBuffer, so crypto.subtle takes it on older and newer TypeScript lib types alike.
function b64url(s: string): ArrayBuffer {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer as ArrayBuffer
}

function params(alg: string): { imp: EcKeyImportParams | RsaHashedImportParams; ver: EcdsaParams | AlgorithmIdentifier } | null {
  if (alg === 'ES256') return { imp: { name: 'ECDSA', namedCurve: 'P-256' }, ver: { name: 'ECDSA', hash: 'SHA-256' } }
  if (alg === 'RS256') return { imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, ver: 'RSASSA-PKCS1-v1_5' }
  return null
}

export class Jwks {
  private keys: Jwk[] = []
  private at = -Infinity
  private tried = -Infinity

  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  private async load(): Promise<void> {
    this.tried = this.now()
    const res = await this.fetcher(this.url)
    if (!res.ok) throw new Error(`jwks ${res.status}`)
    const body = (await res.json()) as { keys?: Jwk[] }
    this.keys = Array.isArray(body.keys) ? body.keys : []
    this.at = this.now()
  }

  async key(kid: string): Promise<Jwk | null> {
    if (this.now() - this.at > KEEP_MS) await this.load()
    let k = this.keys.find((x) => x.kid === kid)
    if (!k && this.now() - this.tried > RETRY_MS) {
      await this.load()
      k = this.keys.find((x) => x.kid === kid)
    }
    return k ?? null
  }
}

export async function verifySession(token: string, jwks: Jwks, issuer: string, nowMs = Date.now()): Promise<JwtResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  let head: Obj, claims: Obj
  try {
    head = JSON.parse(new TextDecoder().decode(b64url(parts[0]!))) as Obj
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1]!))) as Obj
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const alg = typeof head['alg'] === 'string' ? head['alg'] : ''
  const kid = typeof head['kid'] === 'string' ? head['kid'] : ''
  const p = params(alg)
  // an HS256 or alg none token never passes: only the project's published keys do
  if (!p || !kid) return { ok: false, reason: 'signature' }
  const jwk = await jwks.key(kid)
  if (!jwk || (jwk.alg && jwk.alg !== alg)) return { ok: false, reason: 'signature' }
  let good = false
  try {
    const { kid: _k, alg: _a, key_ops: _o, ...pub } = jwk
    const key = await crypto.subtle.importKey('jwk', pub, p.imp, false, ['verify'])
    good = await crypto.subtle.verify(p.ver, key, b64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  } catch {
    good = false
  }
  if (!good) return { ok: false, reason: 'signature' }
  const now = nowMs / 1000
  if (typeof claims['exp'] !== 'number' || claims['exp'] + SKEW_S < now) return { ok: false, reason: 'expired' }
  if (typeof claims['nbf'] === 'number' && claims['nbf'] - SKEW_S > now) return { ok: false, reason: 'expired' }
  const aud = claims['aud']
  const audOk = aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated'))
  if (claims['iss'] !== issuer || !audOk || claims['role'] !== 'authenticated') return { ok: false, reason: 'project' }
  if (claims['is_anonymous'] === true) return { ok: false, reason: 'anonymous' }
  const sub = claims['sub']
  if (typeof sub !== 'string' || !UUID.test(sub)) return { ok: false, reason: 'malformed' }
  return { ok: true, user: sub.toLowerCase() }
}
