// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir proxy's routes. Nobody signs in: an install registers for a token, and every
// model call reserves its worst case against the install's, the address's and the
// edition's daily caps (migrations/0020_mimir_proxy.sql), then settles what it used.
//   POST register        {edition, key}          -> {install, token}
//   POST v1/messages     Messages API, streamed  (x-sx-install: token)
//   GET  quota                                   (x-sx-install: token): v1 fields, plus v2 (fractions for
//                                                 a usage page)
//   POST forget          deletes saved chats (x-sx-install: token)
// Saved chats: a call is saved when the edition saves by default (alpha: SlicerX) or the
// client sends x-sx-share: 1, never with x-sx-share: 0. x-sx-session and x-sx-version file it; without
// them it goes under one key per install and Melbourne day.
// Every error is {type: 'error', error: {type, code, message, ...}}; errors.ts has the codes.
import { MAX_BODY_BYTES, MODEL, shape, worstInput } from './shape.ts'
import { StreamTap } from './usage.ts'
import { capRefusal, errorId, installRef, logLine, type MimirCode, PAUSED, providerPaused } from './errors.ts'

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
// a saved turn larger than this is not stored (the database refuses it too)
const MAX_STORED_BYTES = 1_048_576
// tokens the thinking setting may add to a prompt, counted when the count went without it
const THINKING_SLACK = 512
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } })
}
const TYPES: Partial<Record<number, string>> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'mimir_limit', 503: 'overloaded_error' }
// `type` keeps the Messages API's error types, so a client that knows only those still reads it
const fail = (status: number, code: MimirCode, message: string, extra: Obj = {}) =>
  json(status, { type: 'error', error: { type: TYPES[status] ?? 'api_error', code, message, ...extra } })

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

// refusals that an exact token count can turn around
// (net_full is not one: the network had used its day before this call)
const DAILY_CAPS = new Set(['install_daily', 'ip_daily', 'net_daily', 'edition_daily'])
// refusals that count toward the per-minute rates, so a refused client cannot retry for free.
// Rate refusals are not counted: they come only while the window is already full, and
// counting them would grow the log at the flood's own rate.
const COUNTED = new Set([...DAILY_CAPS, 'net_full', 'install_busy', 'ip_busy', 'net_busy', 'edition_busy'])

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
  const r = e instanceof RpcError ? capRefusal(e.hint, new Date()) : null
  if (r && e instanceof RpcError) return fail(r.status, r.code, r.message, { reason: e.hint, ...(r.resetsAt ? { resetsAt: r.resetsAt } : {}) })
  if (e instanceof RpcError && e.hint === 'invalid') return fail(400, 'invalid_request', e.message)
  const id = errorId()
  logLine('error', { code: 'server_error', errorId: id, status: 502, provider: e instanceof Error ? e.message.slice(0, 300) : 'unknown' })
  return fail(502, 'server_error', `mimir could not reach its service. (error ${id})`, { errorId: id })
}

// rate refusals come in floods, so they log without the extra lookup of the install's edition
const RATES = new Set(['install_rate', 'ip_rate'])
async function editionOf(env: Env, tok: string | null): Promise<string | null> {
  if (!tok) return null
  return ((await rpc(env, 'mimir_install_edition', { p_token: tok }).catch(() => null)) as string | null) ?? null
}

// Free mimir is down for everyone when the provider stops taking our key: one alert at most
// every 15 minutes from each instance, through the bug report intake (0012), which posts to
// the team's Discord; its own limit is 10 an hour for one install id.
const ALERT_INSTALL = '00000000-0000-4000-8000-00000000a1e7'
const lastAlert = new WeakMap<Env, number>()
async function alertPaused(env: Env, status: number, line: string, id: string): Promise<void> {
  if (Date.now() - (lastAlert.get(env) ?? 0) < 15 * 60_000) return
  lastAlert.set(env, Date.now())
  await rpc(env, 'submit_bug_report', {
    p_kind: 'manual', p_install_id: ALERT_INSTALL, p_app_version: 'mimir-proxy', p_commit: 'edge', p_os: 'supabase-edge',
    p_printer: '', p_title: 'Free mimir is paused: the model provider refused our key', p_body: `Status ${status}, error ${id}: ${line}`,
    p_stack: '', p_log_tail: '', p_fingerprint: 'mimir-provider-paused',
  }).catch((e) => console.error('mimir alert failed:', e instanceof Error ? e.message : 'unknown'))
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

// what a saved chat keeps: the request without image data, its system prompt and tool list
// apart (saved once per distinct text, under prompt.hash), and the reply with every tool call in full
export async function transcript(body: Obj, reply: StreamTap['reply'], usage: StreamTap['usage']): Promise<{ kept: Obj; prompt: Obj; hash: string }> {
  const req = JSON.parse(
    JSON.stringify(body, (k, v) => (k === 'data' && typeof v === 'string' ? `[image, ${v.length} base64 chars]` : v)),
  ) as Obj
  delete req['cache_control']
  const prompt = { system: req['system'] ?? null, tools: req['tools'] ?? null }
  delete req['system']
  delete req['tools']
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(prompt)))
  const hash = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { kept: { request: req, prompt: hash, reply, usage }, prompt, hash }
}

// the Melbourne day, as a session key for a client that sent none
export function dayKey(now = new Date()): string {
  return `day-${new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(now).replaceAll('-', '')}`
}

async function messages(req: Request, env: Env): Promise<Response> {
  const tok = token(req)
  if (!tok) return fail(401, 'not_registered', 'This install is not registered with mimir.', { reason: 'unknown_install' })
  const text = await readBody(req)
  if (text === null) return fail(413, 'too_large', 'The conversation is too large for mimir.')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail(400, 'invalid_request', 'The body is not JSON.')
  }
  const s = shape(raw)
  if (!s.ok) return fail(400, 'invalid_request', s.error)
  const ip = clientIp(req, env.ipSource)
  if (!ip) return rpcFailure(new RpcError('no_ip', 'no client address'))

  const reserve = (prompt: number) =>
    rpc(env, 'mimir_reserve', {
      p_token: tok, p_ip: ip, p_model: MODEL, p_input: worstInput(prompt, s.maxOutput, s.maxSearches), p_output: s.maxOutput,
      p_searches: s.maxSearches,
    }) as Promise<string>
  const refused = async (e: unknown) => {
    if (e instanceof RpcError && COUNTED.has(e.hint)) await rpc(env, 'mimir_refused', { p_token: tok, p_ip: ip }).catch(() => {})
    const res = rpcFailure(e)
    if (e instanceof RpcError) {
      const err = ((await res.clone().json()) as { error: Obj }).error
      logLine('info', { code: err['code'], reason: e.hint, edition: RATES.has(e.hint) ? null : await editionOf(env, tok), install: await installRef(tok), status: res.status })
    }
    return res
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

  // the client's choice; null leaves it to the edition's default
  const shareHeader = req.headers.get('x-sx-share')
  const share = shareHeader === '1' ? true : shareHeader === '0' ? false : null
  const sessionHeader = req.headers.get('x-sx-session') ?? ''
  const session = SESSION.test(sessionHeader) ? sessionHeader : dayKey()
  const versionHeader = req.headers.get('x-sx-version') ?? ''
  const version = VERSION.test(versionHeader) ? versionHeader : 'unknown'
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
    if (answered && tap.complete && !tap.failed && share !== false) {
      const t = await transcript(s.body, tap.reply, u)
      if (new TextEncoder().encode(JSON.stringify(t.kept)).length > MAX_STORED_BYTES) return
      await rpc(env, 'mimir_save_chat', {
        p_call: call, p_share: share, p_session_key: session, p_app_version: version, p_model: MODEL,
        p_prompt_hash: t.hash, p_prompt: t.prompt, p_transcript: t.kept,
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
  } catch (e) {
    await later(settle(false))
    const id = errorId()
    logLine('error', { code: 'unreachable', errorId: id, edition: await editionOf(env, tok), install: await installRef(tok), status: 0, provider: e instanceof Error ? e.message.slice(0, 300) : 'unknown' })
    return fail(502, 'unreachable', `mimir could not reach the model. Try again in a moment. (error ${id})`, { errorId: id })
  }
  if (!up.ok || !up.body) {
    // nothing was generated, so the call settles at nothing; the provider's words stay here,
    // in the function log only: its status and error, never the key or the prompt
    const e = await upstreamError(up)
    await later(settle(false))
    const id = errorId()
    const paused = providerPaused(up.status, e.type, e.message)
    const busy = !paused && (up.status === 429 || up.status === 529 || up.status >= 500)
    const code: MimirCode = paused ? 'paused' : busy ? 'provider_busy' : 'provider_error'
    logLine('error', { code, errorId: id, edition: await editionOf(env, tok), install: await installRef(tok), status: up.status, provider: e.line })
    if (paused) {
      await later(alertPaused(env, up.status, e.line, id))
      return fail(503, 'paused', PAUSED, { errorId: id })
    }
    if (busy) return fail(503, 'provider_busy', `The model is busy right now. Try again in a moment. (error ${id})`, { errorId: id })
    // a request the provider calls invalid is the caller's to fix: its reason goes along as
    // `detail` for developers, and the person reads a plain message
    const detail = e.type === 'invalid_request_error' && e.message ? { detail: e.message } : {}
    return fail(up.status === 400 ? 400 : 502, 'provider_error', `mimir could not get an answer to that. (error ${id})`, { errorId: id, ...detail })
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

// The provider's error type and message from a refused call, cut short. Its validation
// messages name fields, not what the person wrote.
async function upstreamError(up: Response): Promise<{ type?: string; message?: string; line: string }> {
  try {
    const e = (JSON.parse(await up.text()) as Obj)['error']
    if (typeof e !== 'object' || e === null) return { line: 'no error body' }
    const type = String((e as Obj)['type'])
    const message = String((e as Obj)['message']).slice(0, 300)
    return { type, message, line: `${type}: ${message}` }
  } catch {
    return { line: 'unreadable error body' }
  }
}

// Thinking blocks taken out of the messages, and their bytes. count_tokens refuses a signed
// block made in another conversation, which every agent turn carries back.
export function withoutThinking(messages: unknown): { messages: unknown; bytes: number } {
  if (!Array.isArray(messages)) return { messages, bytes: 0 }
  const enc = new TextEncoder()
  let bytes = 0
  const out = messages.map((m) => {
    if (!isObj(m) || !Array.isArray(m['content'])) return m
    const kept = (m['content'] as unknown[]).filter((b) => {
      if (!isObj(b) || (b['type'] !== 'thinking' && b['type'] !== 'redacted_thinking')) return true
      bytes += enc.encode(JSON.stringify(b)).length
      return false
    })
    if (kept.length === m['content'].length) return m
    return { ...m, content: kept.length ? kept : [{ type: 'text', text: '.' }] }
  })
  return { messages: out, bytes }
}

// The prompt's token count from the provider, or null when it cannot say. Thinking blocks
// are counted a token a byte instead, signature and all: the signature carries the whole
// thinking, so that never undercounts.
async function countTokens(env: Env, body: Obj): Promise<number | null> {
  const { model, system, tools, tool_choice } = body
  const { messages, bytes } = withoutThinking(body['messages'])
  // with its blocks gone, the thinking setting would ask for them back
  const thinking = bytes ? undefined : body['thinking']
  try {
    const res = await (env.fetch ?? fetch)(`${env.upstream}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, system, messages, tools, tool_choice, thinking }),
    })
    if (!res.ok) {
      logLine('error', { code: 'count_tokens', status: res.status, provider: (await upstreamError(res)).line })
      return null
    }
    const n = ((await res.json()) as Obj)['input_tokens']
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.ceil(n) + bytes + (bytes ? THINKING_SLACK : 0) : null
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
      if (text === null) return fail(413, 'too_large', 'The request is too large.')
      let body: Obj = {}
      try {
        const parsed = JSON.parse(text) as unknown
        if (typeof parsed === 'object' && parsed !== null) body = parsed as Obj
      } catch {
        // an unreadable body is an unknown edition
      }
      const edition = typeof body['edition'] === 'string' ? body['edition'] : ''
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(edition)) return fail(400, 'invalid_request', 'Unknown edition.')
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
      if (!tok) return fail(401, 'not_registered', 'This install is not registered with mimir.', { reason: 'unknown_install' })
      const ip = clientIp(req, env.ipSource)
      if (!ip) return rpcFailure(new RpcError('no_ip', 'no client address'))
      try {
        const [rows, v2] = await Promise.all([rpc(env, 'mimir_quota', { p_token: tok, p_ip: ip }) as Promise<Obj[]>, rpc(env, 'mimir_usage', { p_token: tok })])
        return json(200, { ...(rows[0] ?? {}), v2 })
      } catch (e) {
        return rpcFailure(e)
      }
    }
    if (route === '/forget' && req.method === 'POST') {
      const tok = token(req)
      if (!tok) return fail(401, 'not_registered', 'This install is not registered with mimir.', { reason: 'unknown_install' })
      try {
        return json(200, { deleted: await rpc(env, 'mimir_forget', { p_token: tok }) })
      } catch (e) {
        return rpcFailure(e)
      }
    }
    return fail(404, 'not_found', 'No such mimir route.')
  } catch (e) {
    const id = errorId()
    logLine('error', { code: 'server_error', errorId: id, status: 500, provider: e instanceof Error ? e.message.slice(0, 300) : 'unknown' })
    return fail(500, 'server_error', `mimir hit a problem on our side. (error ${id})`, { errorId: id })
  }
}
