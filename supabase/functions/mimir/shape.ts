// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What mimir may send through the proxy. The request is rebuilt from an allowlist, never
// forwarded as is: the model is pinned, the reply and web searches are capped, thinking is
// adaptive, only the app's own tools and web search pass, and cache points sit on the
// tools and system prompt so every turn after the first reads them from the cache.

export const MODEL = 'claude-haiku-5-5'
export const MAX_OUTPUT = 8192
export const MAX_SEARCHES = 3
export const MAX_BODY_BYTES = 2_000_000
const MAX_MESSAGES = 400
const MAX_TOOLS = 128
const MAX_BREAKPOINTS = 4
// a rough upper bound for one image, in tokens
const IMAGE_TOKENS = 2000

type Obj = Record<string, unknown>
export type Shaped =
  | { ok: true; body: Obj; inputEstimate: number; maxOutput: number; maxSearches: number }
  | { ok: false; error: string }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const EPHEMERAL = { type: 'ephemeral' }

class Refused extends Error {}
const refuse = (msg: string): never => {
  throw new Refused(msg)
}

// a cache point the client set, kept only in its plain 5-minute form
function cachePoint(b: Obj, out: Obj): void {
  if (b['cache_control'] !== undefined) out['cache_control'] = { ...EPHEMERAL }
}

function textBlock(b: Obj): Obj {
  if (typeof b['text'] !== 'string') refuse('a text block needs text')
  const out: Obj = { type: 'text', text: b['text'] }
  cachePoint(b, out)
  return out
}

function imageBlock(b: Obj): Obj {
  const src = b['source']
  // base64 only: a url source would have the provider fetch it for us
  if (!isObj(src) || src['type'] !== 'base64' || typeof src['data'] !== 'string' || typeof src['media_type'] !== 'string') {
    refuse('images must be base64')
  }
  const s = src as Obj
  if (!/^image\/(png|jpeg|gif|webp)$/.test(s['media_type'] as string)) refuse('unsupported image type')
  const out: Obj = { type: 'image', source: { type: 'base64', media_type: s['media_type'], data: s['data'] } }
  cachePoint(b, out)
  return out
}

function toolResultContent(c: unknown): unknown {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) refuse('bad tool result')
  return (c as unknown[]).map((x) => {
    if (!isObj(x)) return refuse('bad tool result')
    if (x['type'] === 'text') return textBlock(x)
    if (x['type'] === 'image') return imageBlock(x)
    return refuse('tool results hold text and images only')
  })
}

function block(b: unknown, role: string): Obj {
  if (!isObj(b)) return refuse('bad content block')
  const t = b['type']
  if (t === 'text') return textBlock(b)
  if (t === 'image' && role === 'user') return imageBlock(b)
  if (t === 'tool_result' && role === 'user') {
    if (typeof b['tool_use_id'] !== 'string') refuse('a tool result needs its tool_use_id')
    const out: Obj = { type: 'tool_result', tool_use_id: b['tool_use_id'], content: toolResultContent(b['content'] ?? '') }
    if (b['is_error'] === true) out['is_error'] = true
    cachePoint(b, out)
    return out
  }
  if (t === 'tool_use' && role === 'assistant') {
    if (typeof b['id'] !== 'string' || typeof b['name'] !== 'string' || !isObj(b['input'])) refuse('bad tool use')
    return { type: 'tool_use', id: b['id'], name: b['name'], input: b['input'] }
  }
  // replayed history from earlier turns, passed back unchanged as the API requires
  if (role === 'assistant' && (t === 'thinking' || t === 'redacted_thinking' || t === 'server_tool_use' || t === 'web_search_tool_result')) {
    return structuredClone(b)
  }
  return refuse(`content of type ${String(t)} is not allowed`)
}

function messages(raw: unknown): Obj[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) refuse('messages must be a list of 1 to 400')
  return (raw as unknown[]).map((m) => {
    if (!isObj(m) || (m['role'] !== 'user' && m['role'] !== 'assistant')) return refuse('each message is from the user or the assistant')
    const role = m['role'] as string
    const c = m['content']
    if (typeof c === 'string') return { role, content: c }
    if (!Array.isArray(c) || c.length === 0) return refuse('message content must be text or blocks')
    return { role, content: c.map((b) => block(b, role)) }
  })
}

function system(raw: unknown): Obj[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'string') return [{ type: 'text', text: raw }]
  if (!Array.isArray(raw)) return refuse('system must be text')
  return raw.map((b) => (isObj(b) && b['type'] === 'text' ? textBlock(b) : refuse('system holds text blocks only')))
}

function tools(raw: unknown): { list: Obj[]; searches: number } {
  if (raw === undefined) return { list: [], searches: 0 }
  if (!Array.isArray(raw) || raw.length > MAX_TOOLS) return refuse('tools must be a list of at most 128')
  let searches = 0
  const list = raw.map((t) => {
    if (!isObj(t)) return refuse('bad tool')
    if (typeof t['type'] === 'string' && t['type'] !== 'custom') {
      if (!t['type'].startsWith('web_search_')) return refuse(`tool ${t['type']} is not allowed`)
      const asked = typeof t['max_uses'] === 'number' && t['max_uses'] > 0 ? Math.floor(t['max_uses']) : MAX_SEARCHES
      searches = Math.min(asked, MAX_SEARCHES)
      return { type: 'web_search_20250305', name: 'web_search', max_uses: searches }
    }
    if (typeof t['name'] !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t['name'])) return refuse('bad tool name')
    if (!isObj(t['input_schema'])) return refuse('a tool needs an input schema')
    const out: Obj = { name: t['name'], input_schema: t['input_schema'] }
    if (typeof t['description'] === 'string') out['description'] = t['description']
    if (t['strict'] === true) out['strict'] = true
    cachePoint(t, out)
    return out
  })
  return { list, searches }
}

function toolChoice(raw: unknown): Obj | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) return refuse('bad tool choice')
  const t = raw['type']
  if (t === 'auto' || t === 'none' || t === 'any') return { type: t }
  if (t === 'tool' && typeof raw['name'] === 'string') return { type: 'tool', name: raw['name'] }
  return refuse('bad tool choice')
}

function* cached(body: Obj): Generator<Obj> {
  for (const t of (body['tools'] as Obj[] | undefined) ?? []) if (t['cache_control']) yield t
  for (const b of (body['system'] as Obj[] | undefined) ?? []) if (b['cache_control']) yield b
  for (const m of body['messages'] as Obj[]) {
    if (!Array.isArray(m['content'])) continue
    for (const b of m['content'] as Obj[]) {
      if (b['cache_control']) yield b
      if (Array.isArray(b['content'])) for (const c of b['content'] as Obj[]) if (c['cache_control']) yield c
    }
  }
}

// Cache points: the client's are kept; without any on the tools or system prompt, one goes
// on the last tool and one on the last system block. Over the limit, the message ones go.
// The conversation tail gets automatic caching when a slot is left.
function placeCache(body: Obj): void {
  const tl = (body['tools'] as Obj[] | undefined) ?? []
  const sys = (body['system'] as Obj[] | undefined) ?? []
  const lastTool = [...tl].reverse().find((t) => t['type'] === undefined)
  if (lastTool && !tl.some((t) => t['cache_control'])) lastTool['cache_control'] = { ...EPHEMERAL }
  const lastSys = sys[sys.length - 1]
  if (lastSys && !sys.some((b) => b['cache_control'])) lastSys['cache_control'] = { ...EPHEMERAL }
  let n = [...cached(body)].length
  if (n > MAX_BREAKPOINTS) {
    for (const b of [...cached(body)].filter((b) => !tl.includes(b) && !sys.includes(b))) {
      if (n <= MAX_BREAKPOINTS) break
      delete b['cache_control']
      n--
    }
  }
  if (n < MAX_BREAKPOINTS) body['cache_control'] = { ...EPHEMERAL }
}

// prompt tokens, over-estimated: a token for every 3 bytes of text, images at a fixed bound
function estimate(body: Obj): number {
  let images = 0
  const text = JSON.stringify(body, (k, v) => {
    if (k === 'data' && typeof v === 'string') {
      images++
      return ''
    }
    return v
  })
  return Math.ceil(new TextEncoder().encode(text).length / 3) + images * IMAGE_TOKENS
}

export function shape(raw: unknown): Shaped {
  try {
    if (!isObj(raw)) refuse('the body must be a JSON object')
    const r = raw as Obj
    const asked = typeof r['max_tokens'] === 'number' && r['max_tokens'] > 0 ? Math.floor(r['max_tokens']) : MAX_OUTPUT
    const maxOutput = Math.min(asked, MAX_OUTPUT)
    const t = tools(r['tools'])
    const body: Obj = { model: MODEL, max_tokens: maxOutput, stream: true, messages: messages(r['messages']) }
    const sys = system(r['system'])
    if (sys) body['system'] = sys
    if (t.list.length > 0) {
      body['tools'] = t.list
      const choice = toolChoice(r['tool_choice'])
      if (choice) body['tool_choice'] = choice
    }
    body['thinking'] = { type: 'adaptive' }
    body['output_config'] = { effort: 'medium' }
    placeCache(body)
    return { ok: true, body, inputEstimate: estimate(body), maxOutput, maxSearches: t.searches }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message }
    throw e
  }
}
