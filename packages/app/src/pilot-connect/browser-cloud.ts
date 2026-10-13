// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud in the browser build: the same proxy routes the desktop's Rust host uses (quota, forget and
// v1/messages), straight from the page, for signed-in members only. Each call carries the member's session token,
// which the proxy checks against the project's signing keys; the proxy keys the web edition's caps by the user, so
// there is no install token and nothing to register. Signed out, the host says so (needsSignIn) and sends nothing.
import type { MimirCloudHost, MimirQuota } from './cloud'

export interface BrowserCloudOptions {
  /** The proxy, ending in /functions/v1/mimir. */
  base: string
  /** The member's current session token, or null when signed out. */
  session: () => string | null
  fetch?: typeof fetch
}

const TIMEOUT_MS = 20_000

/** The proxy's error, read for its message, its code (`day_used`, `paused`, ...) and the database's reason. */
async function refusal(res: Response): Promise<Error & { status: number; code?: string; reason?: string }> {
  let message = `mimir cloud answered ${res.status}`
  let code: string | undefined
  let reason: string | undefined
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string; reason?: string } }
    if (body.error?.message) message = body.error.message
    if (body.error?.code) code = body.error.code
    if (body.error?.reason) reason = body.error.reason
  } catch {
    // not JSON
  }
  return Object.assign(new Error(message), { status: res.status, ...(code ? { code } : {}), ...(reason ? { reason } : {}) })
}

export interface BrowserMimirCloud extends MimirCloudHost {
  /** Sends a model request to the proxy with the session token; only to this proxy's messages route. */
  send(url: string, init: { method: string; headers: Record<string, string>; body?: string }, signal?: AbortSignal): Promise<Response>
}

/** A host for the current sign-in state: make a new one when the member signs in or out, so the app sees the change. */
export function createBrowserMimirCloud(o: BrowserCloudOptions): BrowserMimirCloud {
  const base = o.base.replace(/\/+$/, '')
  const go = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const signedOut = () => Object.assign(new Error('Sign in to use mimir.'), { status: 401, reason: 'sign_in' })

  const call = async (url: string, init: RequestInit): Promise<Response> => {
    const t = o.session()
    if (!t) throw signedOut()
    const res = await go(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${t}` } })
    if (!res.ok) throw await refusal(res)
    return res
  }

  return {
    needsSignIn: o.session() === null,
    async quota(): Promise<MimirQuota> {
      const res = await call(`${base}/quota`, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) })
      const r = (await res.json()) as Record<string, unknown>
      const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0)
      return { edition: String(r['edition'] ?? ''), day: String(r['day'] ?? ''), installUsed: n('install_used'), installCap: n('install_cap'), ipUsed: n('ip_used'), ipCap: n('ip_cap'), editionOpen: r['edition_open'] === true }
    },
    async forget(): Promise<number> {
      const res = await call(`${base}/forget`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(TIMEOUT_MS) })
      const r = (await res.json()) as { deleted?: unknown }
      return typeof r.deleted === 'number' ? r.deleted : 0
    },
    // the member's account is the install; there is nothing to register
    async register(): Promise<void> {},
    send(url, init, signal) {
      if (url !== `${base}/v1/messages`) return Promise.reject(new Error('mimir cloud sends only to its own proxy'))
      return call(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), ...(signal ? { signal } : {}) })
    },
  }
}
