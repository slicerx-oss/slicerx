// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir proxy's routes. Nobody signs in: an install registers for a token, and every
// model call reserves its worst case against the install's, the address's and the
// edition's daily caps (migrations/0020_mimir_proxy.sql), then settles what it used.
//   POST register        {edition, key}          -> {install, token}
//   POST v1/messages     Messages API, streamed  (x-sx-install: token)
//   GET  quota                                   (x-sx-install: token)
//   POST forget          deletes shared sessions (x-sx-install: token)
// Shared sessions: x-sx-share: 1 with x-sx-session and x-sx-version stores the turn.
import { MAX_BODY_BYTES, MODEL, shape, worstInput } from './shape.ts'
import { StreamTap } from './usage.ts'

export interface Env {
  supabaseUrl: string
  serviceKey: string
  anthropicKey: string
  upstream: string
  ipSource: 'cf-connecting-ip' | 'x-forwarded-for-last'
  waitUntil?: (p: Promise<unknown>) => void
  fetch?: typeof fetch
}

type Obj = Record<string, unknown>
const TOKEN = /^[0-9a-f]{64}$/
const SESSION = /^[A-Za-z0-9_-]{1,64}$/
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/
const KEY = /^[A-Za-z0-9_-]{16,128}$/
const MAX_REGISTER_BYTES = 4096
// a shared session's turn larger than this is not stored (the database refuses it too)
const MAX_STORED_BYTES = 262_144

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } })
}
const fail = (status: number, type: string, message: string, reason?: string) =>
  json(status, { type: 'error', error: { type, message, ...(reason ? { reason } : {}) } })

// The client's address, from the one header the host's edge sets itself (index.ts says
// which). Never the first x-forwarded-for entry: the client writes that one.
export function clientIp(req: Request, src: Env['ipSource']): string {
  if (src === 'x-forwarded-for-last') {
    const parts = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    return parts[parts.length - 1] ?? ''
  }
  return (req.headers.get('cf-connecting-ip') ?? '').trim()
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
  edition_daily: [429, "mimir's daily limit is used up. It resets at midnight Melbourne time."],
  install_rate: [429, 'mimir is getting requests too quickly. Wait a minute and try again.'],
  install_busy: [429, 'mimir is still answering on this computer. Try again when it finishes.'],
  ip_busy: [429, 'mimir is still answering on this network. Try again when it finishes.'],
  ip_rate: [429, 'mimir is getting requests too quickly from this network. Wait a minute and try again.'],
  edition_busy: [503, 'mimir is busy. Try again in a moment.'],
  register_limit: [429, 'Too many new installs from this network today.'],
  edition_register_limit: [429, 'mimir is taking no more new installs today. Try again tomorrow.'],
  register_key: [403, 'This build of the app cannot register with mimir.'],
  paused: [503, 'mimir is paused for now.'],
  unknown_install: [401, 'This install is not registered with mimir.'],
  no_ip: [400, 'mimir could not tell which network this came from.'],
}
// refusals that an exact token count can turn around
const DAILY_CAPS = new Set(['install_daily', 'ip_daily', 'edition_daily'])
// refusals that count toward the per-minute rates, so a refused client cannot retry for free.
// Rate refusals are not counted: they come only while the window is already full, and
// counting them would grow the log at the flood's own rate.
const COUNTED = new Set([...DAILY_CAPS, 'install_busy', 'ip_busy', 'edition_busy'])

// Each install's conversations cache apart from every other install's: a mark after the
// shared tools and system prompt, so neither a cache hit's speed nor the cost /quota shows
// can tell one install what another sent.
async function installMark(tok: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mimir-cache|${tok}`))
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
export function marked(body: Obj, mark: string): Obj {
  return { ...body, system: [...((body['system'] as Obj[] | undefined) ?? []), { type: 'text', text: `scope ${mark}` }] }
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

async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) {
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
  if (!ip) return rpcFailure(new RpcError('no_ip', 'no client address'))

  const reserve = (prompt: number) =>
    rpc(env, 'mimir_reserve', {
      p_token: tok, p_ip: ip, p_model: MODEL, p_input: worstInput(prompt, s.maxOutput, s.maxSearches), p_output: s.maxOutput,
      p_searches: s.maxSearches,
    }) as Promise<string>
  const refused = async (e: unknown) => {
    if (e instanceof RpcError && COUNTED.has(e.hint)) await rpc(env, 'mimir_refused', { p_token: tok, p_ip: ip }).catch(() => {})
    return rpcFailure(e)
  }
  let call: string
  try {
    call = await reserve(s.promptEstimate)
  } catch (e) {
    // the byte count overstates most prompts; when it is what hit a cap, count exactly and try once more
    const exact = e instanceof RpcError && DAILY_CAPS.has(e.hint) ? await countTokens(env, s.body) : null
    if (exact === null) return refused(e)
    try {
      call = await reserve(exact)
    } catch (e2) {
      return refused(e2)
    }
  }

  const share = req.headers.get('x-sx-share') === '1'
  const session = req.headers.get('x-sx-session') ?? ''
  const version = req.headers.get('x-sx-version') ?? ''
  const tap = new StreamTap()
  // stored only for a call that answered in full; a failed or refused call keeps nothing. A
  // reply the client cut off settles at its whole reply allowance, since its last count
  // never came.
  const settle = async (answered: boolean, cut = false) => {
    tap.end()
    const u = cut ? { ...tap.usage, output: Math.max(tap.usage.output, s.maxOutput) } : tap.usage
    await rpc(env, 'mimir_settle', {
      p_call: call, p_model: MODEL, p_input: u.input, p_cache_write: u.cacheWrite, p_cache_read: u.cacheRead,
      p_output: u.output, p_searches: u.searches,
    })
    if (answered && tap.complete && !tap.failed && share && SESSION.test(session) && VERSION.test(version)) {
      const kept = transcript(s.body, tap.reply, u)
      if (new TextEncoder().encode(JSON.stringify(kept)).length > MAX_STORED_BYTES) return
      await rpc(env, 'mimir_store_session', {
        p_call: call, p_session_key: session, p_app_version: version, p_model: MODEL, p_transcript: kept,
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
      body: JSON.stringify(marked(s.body, await installMark(tok))),
    })
  } catch {
    await later(settle(false))
    return fail(502, 'api_error', 'mimir could not reach the model provider.')
  }
  if (!up.ok || !up.body) {
    // nothing was generated, so the call settles at nothing; the provider's words stay here
    await up.body?.cancel().catch(() => {})
    await later(settle(false))
    if (up.status === 429 || up.status === 529 || up.status >= 500) return fail(503, 'overloaded_error', 'The model provider is busy. Try again in a moment.')
    return fail(502, 'api_error', `The model provider refused the request (${up.status}).`)
  }

  const enc = new TextEncoder()
  const pass = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      const out = tap.push(chunk)
      if (out) ctl.enqueue(enc.encode(out))
    },
    flush(ctl) {
      const rest = tap.end()
      if (rest) ctl.enqueue(enc.encode(rest))
      // a stream that ended without message_stop, or with an error, may have billed more
      // than it counted: it settles at the whole reply allowance, as a cut-off one does
      later(settle(true, !tap.complete || tap.failed))
    },
    cancel() {
      later(settle(false, true))
    },
  })
  return new Response(up.body.pipeThrough(pass), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  })
}

// The prompt's exact token count from the provider, or null when it cannot say.
async function countTokens(env: Env, body: Obj): Promise<number | null> {
  const { model, system, messages, tools, tool_choice, thinking } = body
  try {
    const res = await (env.fetch ?? fetch)(`${env.upstream}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, system, messages, tools, tool_choice, thinking }),
    })
    if (!res.ok) return null
    const n = ((await res.json()) as Obj)['input_tokens']
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null
  } catch {
    return null
  }
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, '')
  const route = path.slice(path.indexOf('/mimir') + '/mimir'.length)
  try {
    if (route === '/v1/messages' && req.method === 'POST') return await messages(req, env)
    if (route === '/register' && req.method === 'POST') {
      const text = await readBody(req, MAX_REGISTER_BYTES)
      if (text === null) return fail(413, 'request_too_large', 'The request is too large.')
      let body: Obj = {}
      try {
        const parsed = JSON.parse(text) as unknown
        if (typeof parsed === 'object' && parsed !== null) body = parsed as Obj
      } catch {
        // an unreadable body is an unknown edition
      }
      const edition = typeof body['edition'] === 'string' ? body['edition'] : ''
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(edition)) return fail(400, 'invalid_request_error', 'Unknown edition.')
      const key = typeof body['key'] === 'string' && KEY.test(body['key']) ? body['key'] : ''
      if (!key) return rpcFailure(new RpcError('register_key', 'no registration key'))
      const ip = clientIp(req, env.ipSource)
      if (!ip) return rpcFailure(new RpcError('no_ip', 'no client address'))
      try {
        const rows = (await rpc(env, 'mimir_register', { p_edition: edition, p_ip: ip, p_key: key })) as Obj[]
        const r = rows[0] ?? {}
        return json(200, { install: r['install_id'], token: r['token'] })
      } catch (e) {
        return rpcFailure(e)
      }
    }
    if (route === '/quota' && req.method === 'GET') {
      const tok = token(req)
      if (!tok) return fail(401, 'authentication_error', 'This install is not registered with mimir.', 'unknown_install')
      const ip = clientIp(req, env.ipSource)
      if (!ip) return rpcFailure(new RpcError('no_ip', 'no client address'))
      try {
        const rows = (await rpc(env, 'mimir_quota', { p_token: tok, p_ip: ip })) as Obj[]
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
