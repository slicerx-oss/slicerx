// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir proxy's routes. Nobody signs in: an install registers for a token, and every
// model call reserves its worst case against the install's, the address's and the
// edition's daily caps (migrations/0020_mimir_proxy.sql), then settles what it used.
//   POST register        {edition}               -> {install, token}
//   POST v1/messages     Messages API, streamed  (x-sx-install: token)
//   GET  quota                                   (x-sx-install: token)
//   POST forget          deletes shared sessions (x-sx-install: token)
// Shared sessions: x-sx-share: 1 with x-sx-session and x-sx-version stores the turn.
import { MAX_BODY_BYTES, MODEL, shape } from './shape.ts'
import { StreamTap } from './usage.ts'

export interface Env {
  supabaseUrl: string
  serviceKey: string
  anthropicKey: string
  upstream: string
  ipSource: 'x-forwarded-for-last' | 'x-forwarded-for-first' | 'x-real-ip' | 'cf-connecting-ip'
  waitUntil?: (p: Promise<unknown>) => void
  fetch?: typeof fetch
}

type Obj = Record<string, unknown>
const TOKEN = /^[0-9a-f]{64}$/
const SESSION = /^[A-Za-z0-9_-]{1,64}$/
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } })
}
const fail = (status: number, type: string, message: string, reason?: string) =>
  json(status, { type: 'error', error: { type, message, ...(reason ? { reason } : {}) } })

export function clientIp(req: Request, src: Env['ipSource']): string {
  if (src === 'x-forwarded-for-last' || src === 'x-forwarded-for-first') {
    const parts = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    return (src === 'x-forwarded-for-last' ? parts[parts.length - 1] : parts[0]) ?? ''
  }
  return (req.headers.get(src) ?? '').trim()
}

class RpcError extends Error {
  constructor(readonly hint: string, message: string) {
    super(message)
  }
}

async function rpc(env: Env, fn: string, args: Obj): Promise<unknown> {
  const f = env.fetch ?? fetch
  const res = await f(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: env.serviceKey, authorization: `Bearer ${env.serviceKey}` },
    body: JSON.stringify(args),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const b = (body ?? {}) as Obj
    throw new RpcError(typeof b['hint'] === 'string' ? b['hint'] : 'error', typeof b['message'] === 'string' ? b['message'] : 'database error')
  }
  return body
}

// how a refused reservation reads to the app
const CAP_MESSAGES: Record<string, [number, string]> = {
  install_daily: [429, "Today's free mimir use on this computer is used up. It resets at midnight Melbourne time."],
  ip_daily: [429, "Today's free mimir use on this network is used up. It resets at midnight Melbourne time."],
  edition_daily: [429, "mimir's free use is used up for today. It resets at midnight Melbourne time."],
  install_rate: [429, 'mimir is getting requests too quickly. Wait a minute and try again.'],
  register_limit: [429, 'Too many new installs from this network today.'],
  paused: [503, 'mimir is paused for now.'],
  unknown_install: [401, 'This install is not registered with mimir.'],
}

function rpcFailure(e: unknown): Response {
  if (e instanceof RpcError && CAP_MESSAGES[e.hint]) {
    const [status, message] = CAP_MESSAGES[e.hint]!
    return fail(status, status === 401 ? 'authentication_error' : 'mimir_limit', message, e.hint)
  }
  if (e instanceof RpcError && e.hint === 'invalid') return fail(400, 'invalid_request_error', e.message)
  return fail(502, 'api_error', 'mimir could not reach its service.')
}

function token(req: Request): string | null {
  const t = req.headers.get('x-sx-install') ?? ''
  return TOKEN.test(t) ? t : null
}

async function readBody(req: Request): Promise<string | null> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > MAX_BODY_BYTES) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  const all = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    all.set(p, o)
    o += p.length
  }
  return new TextDecoder().decode(all)
}

// what a shared session keeps: the request without image data, and the reply
export function transcript(body: Obj, reply: StreamTap['reply'], usage: StreamTap['usage']): Obj {
  const req = JSON.parse(
    JSON.stringify(body, (k, v) => (k === 'data' && typeof v === 'string' ? `[image, ${v.length} base64 chars]` : v)),
  ) as Obj
  delete req['cache_control']
  return { request: req, reply, usage }
}

async function messages(req: Request, env: Env): Promise<Response> {
  const tok = token(req)
  if (!tok) return fail(401, 'authentication_error', 'This install is not registered with mimir.', 'unknown_install')
  const text = await readBody(req)
  if (text === null) return fail(413, 'request_too_large', 'The conversation is too large for mimir.')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail(400, 'invalid_request_error', 'The body is not JSON.')
  }
  const s = shape(raw)
  if (!s.ok) return fail(400, 'invalid_request_error', s.error)

  const ip = clientIp(req, env.ipSource)
  let call: string
  try {
    call = (await rpc(env, 'mimir_reserve', {
      p_token: tok, p_ip: ip, p_model: MODEL, p_input: s.inputEstimate, p_output: s.maxOutput, p_searches: s.maxSearches,
    })) as string
  } catch (e) {
    return rpcFailure(e)
  }

  const share = req.headers.get('x-sx-share') === '1'
  const session = req.headers.get('x-sx-session') ?? ''
  const version = req.headers.get('x-sx-version') ?? ''
  const tap = new StreamTap()
  const settle = async () => {
    tap.end()
    const u = tap.usage
    await rpc(env, 'mimir_settle', {
      p_call: call, p_model: MODEL, p_input: u.input, p_cache_write: u.cacheWrite, p_cache_read: u.cacheRead,
      p_output: u.output, p_searches: u.searches,
    })
    if (share && SESSION.test(session) && VERSION.test(version)) {
      await rpc(env, 'mimir_store_session', {
        p_call: call, p_session_key: session, p_app_version: version, p_model: MODEL, p_transcript: transcript(s.body, tap.reply, u),
      })
    }
  }
  const later = (p: Promise<unknown>) => {
    const q = p.catch((e) => console.error('mimir settle failed:', e instanceof Error ? e.message : 'unknown'))
    if (env.waitUntil) env.waitUntil(q)
    return q
  }

  let up: Response
  try {
    up = await (env.fetch ?? fetch)(`${env.upstream}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(s.body),
    })
  } catch {
    await later(settle())
    return fail(502, 'api_error', 'mimir could not reach the model provider.')
  }
  if (!up.ok || !up.body) {
    // nothing was generated, so the call settles at nothing
    const err = (await up.json().catch(() => null)) as Obj | null
    await later(settle())
    if (up.status === 429 || up.status === 529 || up.status >= 500) return fail(503, 'overloaded_error', 'The model provider is busy. Try again in a moment.')
    const said = (err?.['error'] as Obj | undefined)?.['message']
    return fail(502, 'api_error', `The model provider refused the request (${up.status})${typeof said === 'string' ? `: ${said.slice(0, 300)}` : ''}.`)
  }

  const pass = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      tap.push(chunk)
      ctl.enqueue(chunk)
    },
    flush() {
      later(settle())
    },
  })
  return new Response(up.body.pipeThrough(pass), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  })
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, '')
  const route = path.slice(path.indexOf('/mimir') + '/mimir'.length)
  try {
    if (route === '/v1/messages' && req.method === 'POST') return await messages(req, env)
    if (route === '/register' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Obj
      const edition = typeof body['edition'] === 'string' ? body['edition'] : ''
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(edition)) return fail(400, 'invalid_request_error', 'Unknown edition.')
      try {
        const rows = (await rpc(env, 'mimir_register', { p_edition: edition, p_ip: clientIp(req, env.ipSource) })) as Obj[]
        const r = rows[0] ?? {}
        return json(200, { install: r['install_id'], token: r['token'] })
      } catch (e) {
        return rpcFailure(e)
      }
    }
    if (route === '/quota' && req.method === 'GET') {
      const tok = token(req)
      if (!tok) return fail(401, 'authentication_error', 'This install is not registered with mimir.', 'unknown_install')
      try {
        const rows = (await rpc(env, 'mimir_quota', { p_token: tok, p_ip: clientIp(req, env.ipSource) })) as Obj[]
        return json(200, rows[0] ?? {})
      } catch (e) {
        return rpcFailure(e)
      }
    }
    if (route === '/forget' && req.method === 'POST') {
      const tok = token(req)
      if (!tok) return fail(401, 'authentication_error', 'This install is not registered with mimir.', 'unknown_install')
      try {
        return json(200, { deleted: await rpc(env, 'mimir_forget', { p_token: tok }) })
      } catch (e) {
        return rpcFailure(e)
      }
    }
    return fail(404, 'not_found_error', 'No such mimir route.')
  } catch (e) {
    console.error('mimir error:', e instanceof Error ? e.message : 'unknown')
    return fail(500, 'api_error', 'mimir hit an error.')
  }
}
