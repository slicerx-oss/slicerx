// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's model calls from the browser: the pilot's provider adapters build the request, this
// transport adds the key from the encrypted store and sends it to that provider only. Also the one
// test call the Connect screen makes. Error text never contains the key or request headers.
import type { LlmHttpRequest, LlmTransport } from '@slicerx/contracts'
import { PROVIDERS, type KeyStore, type PilotProvider } from './keys'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'

export interface ConnectConfig {
  provider: PilotProvider
  /** For local servers, and to override the provider's default. */
  baseUrl?: string
  model?: string
}

/** A local model server must be on this computer or the home network: loopback or a private address. */
export function localAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const h = u.hostname.replace(/^\[|\]$/g, '')
    if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true
    const p = h.split('.').map(Number)
    if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false
    const [a = 0, b = 0] = p
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
  } catch {
    return false
  }
}

/** Headers a provider needs for a key. */
export function authHeaders(provider: PilotProvider, key: string | null): Record<string, string> {
  if (provider === 'anthropic') return key ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : {}
  return key ? { authorization: `Bearer ${key}` } : {}
}

function scrub(text: string, key: string | null): string {
  let t = text.slice(0, 300)
  if (key) t = t.split(key).join('[key]')
  return t.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-...')
}

async function failure(res: Response, key: string | null): Promise<Error> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? '')
  } catch {
    // Not JSON.
  }
  const what = res.status === 401 || res.status === 403 ? 'The key was refused' : res.status === 404 ? 'That address has no model API' : res.status === 429 ? 'The provider is rate limiting this key' : `The provider answered ${res.status}`
  return new Error(scrub(detail ? `${what}: ${detail}` : what, key))
}

/** The browser transport. `provider` in requests is the pilot adapter id; the config says who the provider really is. */
export function browserTransport(store: KeyStore, config: () => ConnectConfig | null): LlmTransport {
  return {
    async available() {
      const c = config()
      if (!c) return false
      return !PROVIDERS[c.provider].needsKey || store.has(c.provider)
    },
    async *stream(req: LlmHttpRequest, signal?: AbortSignal) {
      const c = config()
      if (!c) throw new Error(`${ASSISTANT_NAME} is not connected.`)
      if (c.provider === 'local' && !localAllowed(req.url)) throw new Error('A local model must run on this computer or your home network.')
      // A local server's key is optional; the desktop host adds it itself and reads null here.
      const key = PROVIDERS[c.provider].needsKey || c.provider === 'local' ? await store.get(c.provider) : null
      if (PROVIDERS[c.provider].needsKey && !key) throw new Error(`No key is stored for ${ASSISTANT_NAME}. Connect it again in Settings.`)
      const res = await fetch(req.url, { method: req.method, headers: { ...req.headers, ...authHeaders(c.provider, key) }, body: req.body, ...(signal ? { signal } : {}) })
      if (!res.ok) throw await failure(res, key)
      if (!res.body) return
      const reader = res.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        if (value) yield value
      }
    },
  }
}

/**
 * A fetch that asks the desktop host for a local server's model listing, so the webview needs no
 * network access and never holds the server's key. HTTP failures come back as that status.
 */
export function hostLocalFetch(localModels: (baseUrl: string) => Promise<string>): typeof fetch {
  return async (input) => {
    const base = String(input).replace(/\/models$/, '')
    try {
      return new Response(await localModels(base), { status: 200 })
    } catch (e) {
      const status = /^(\d{3}): /.exec(e instanceof Error ? e.message : String(e))?.[1]
      if (status) return new Response(null, { status: Number(status) })
      throw e
    }
  }
}

export interface TestResult {
  ok: boolean
  message: string
}

/**
 * One cheap call that proves the key and address work: the provider's model list. The key goes
 * only to the chosen provider's address.
 */
export async function testConnection(config: ConnectConfig, key: string | null, fetcher: typeof fetch = fetch): Promise<TestResult> {
  const p = PROVIDERS[config.provider]
  if (p.needsKey && !key) return { ok: false, message: 'Paste the API key first.' }
  const base = (config.baseUrl?.trim() || p.defaultBase).replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(`${base}/models`)
  } catch {
    return { ok: false, message: 'That address is not a URL, such as http://localhost:11434/v1.' }
  }
  if (config.provider === 'local' && !localAllowed(url.toString())) return { ok: false, message: 'A local model must run on this computer or your home network, such as http://localhost:11434/v1.' }
  try {
    const res = await fetcher(url.toString(), { headers: authHeaders(config.provider, key) })
    if (!res.ok) return { ok: false, message: (await failure(res, key)).message }
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[]; models?: unknown[] }
    const n = body.data?.length ?? body.models?.length ?? 0
    return { ok: true, message: n ? `Connected to ${p.label}. ${n} ${n === 1 ? 'model' : 'models'} available.` : `Connected to ${p.label}.` }
  } catch {
    return {
      ok: false,
      message: config.provider === 'local' ? 'Nothing answered at that address. Check the address and that the server is running. A server in a browser also needs to allow this page as an origin.' : `Could not reach ${p.label}. Check the network connection.`,
    }
  }
}
