// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What mimir may send through the proxy. The request is rebuilt from an allowlist, never
// forwarded as is: the model is the one the proxy picked for the turn, the reply and web searches are capped, thinking is
// adaptive unless the client turns it off or the call is small (thinkingFor), only the app's own tools, web search and
// tool search pass, and cache points sit on the tools and system prompt so every turn after the first reads them from
// the cache.

// the base model, for every turn the edition does not step up (migrations/0028_mimir_step_up.sql)
export const MODEL = 'claude-haiku-5-5'
export const MAX_OUTPUT = 8192
// Haiku's design turns think long: at 8192 a plan's thinking could fill the reply before any tool call, so the base model
// gets more room; a reply is billed for what it uses, and a cut or unfinished one for this much at most
export const BASE_OUTPUT = 32768
/** The reply cap for the turn's model: the base model's own, every other model's MAX_OUTPUT. */
export const maxOutputFor = (model: string): number => (/^claude-haiku-5-5(-|$)/.test(model) ? BASE_OUTPUT : MAX_OUTPUT)
export const MAX_SEARCHES = 3
// a conversation may carry up to 15 MB of the person's pictures and PDFs (20 MB as base64), plus its text
export const MAX_BODY_BYTES = 24_000_000
const MAX_MESSAGES = 400
// the app's whole catalog goes on every request, most of it deferred behind tool search: the
// desktop tab offers about 300 tools with a busy fleet and every connector, so this leaves room
// to grow. The provider takes up to 10,000 deferred tools.
export const MAX_TOOLS = 512
// the tools that load up front, the old limit, so a request without tool search costs no more
export const MAX_LOADED_TOOLS = 128
// the betas a client may ask for: offering or withdrawing a tool mid-chat by reference. Tool search
// itself needs none. Any other beta is dropped.
export const TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01'
export const BETAS: readonly string[] = [TOOL_CHANGES_BETA]
// the two tool search tools, each by its one name
const SEARCH_TOOLS: Record<string, string> = {
  tool_search_tool_bm25_20251119: 'tool_search_tool_bm25',
  tool_search_tool_regex_20251119: 'tool_search_tool_regex',
}
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_BREAKPOINTS = 4
// the most one image can cost on Haiku 5.5's vision tier, in tokens, kept as the worst case for a
// step-up turn too
const IMAGE_TOKENS = 4784
// what the provider adds for tool use, in tokens, rounded up
const TOOL_OVERHEAD = 1000
// what one web search can add to the prompt, in tokens, rounded up
const SEARCH_RESULT_TOKENS = 30_000
const CONTEXT_TOKENS = 1_000_000

type Obj = Record<string, unknown>
export type Shaped =
  /** `documents`: the request carries a PDF, whose cost bytes can't bound, so it is counted exactly before the call. */
  /** `unanswered`: server tool calls left out of the history because no block anywhere in it answers them. */
  | { ok: true; body: Obj; promptEstimate: number; maxOutput: number; maxSearches: number; documents: number; betas: string[]; unanswered: number }
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

function withoutCachePoints(v: unknown): unknown {
  if (Array.isArray(v)) v.forEach(withoutCachePoints)
  else if (isObj(v)) {
    delete v['cache_control']
    for (const k of Object.keys(v)) withoutCachePoints(v[k])
  }
  return v
}

function textBlock(b: Obj): Obj {
  if (typeof b['text'] !== 'string') refuse('a text block needs text')
  const out: Obj = { type: 'text', text: b['text'] }
  cachePoint(b, out)
  return out
}

// the image blocks shape built, the only objects the estimate counts as images
const IMAGES = new WeakSet<Obj>()

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
  IMAGES.add(out)
  return out
}

// the document blocks shape built: PDFs the person attached, base64 only
const DOCUMENTS = new WeakSet<Obj>()

function documentBlock(b: Obj): Obj {
  const src = b['source']
  // base64 only: a url source would have the provider fetch it for us
  if (!isObj(src) || src['type'] !== 'base64' || src['media_type'] !== 'application/pdf' || typeof src['data'] !== 'string') {
    refuse('documents must be base64 PDFs')
  }
  const out: Obj = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: (src as Obj)['data'] } }
  if (typeof b['title'] === 'string') out['title'] = (b['title'] as string).slice(0, 200)
  cachePoint(b, out)
  DOCUMENTS.add(out)
  return out
}

// a tool a search found, named in a tool result
function toolReference(b: Obj): Obj {
  if (typeof b['tool_name'] !== 'string' || !TOOL_NAME.test(b['tool_name'])) refuse('a tool reference needs a tool name')
  return { type: 'tool_reference', tool_name: b['tool_name'] }
}

function toolResultContent(c: unknown): unknown {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) refuse('bad tool result')
  return (c as unknown[]).map((x) => {
    if (!isObj(x)) return refuse('bad tool result')
    if (x['type'] === 'text') return textBlock(x)
    if (x['type'] === 'image') return imageBlock(x)
    if (x['type'] === 'tool_reference') return toolReference(x)
    return refuse('tool results hold text, images and tool references only')
  })
}

function block(b: unknown, role: string): Obj {
  if (!isObj(b)) return refuse('bad content block')
  const t = b['type']
  if (t === 'text') return textBlock(b)
  if (t === 'image' && role === 'user') return imageBlock(b)
  if (t === 'document' && role === 'user') return documentBlock(b)
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
  // replayed history from earlier turns, passed back unchanged as the API requires, except
  // that cache points anywhere in it go back to the plain 5-minute form
  if (role === 'assistant' && (t === 'thinking' || t === 'redacted_thinking' || t === 'server_tool_use' || t === 'web_search_tool_result' || t === 'tool_search_tool_result')) {
    const out = withoutCachePoints(structuredClone(b)) as Obj
    cachePoint(b, out)
    return out
  }
  return refuse(`content of type ${String(t)} is not allowed`)
}

// a system message that offers or withdraws tools the request already declares, by name; free
// text there would read as our own instructions, so it never passes
function toolChange(m: Obj): Obj {
  const c = m['content']
  if (!Array.isArray(c) || c.length === 0) return refuse('a system message only adds or withdraws tools')
  return {
    role: 'system',
    content: c.map((b) => {
      if (!isObj(b) || (b['type'] !== 'tool_addition' && b['type'] !== 'tool_removal')) return refuse('a system message only adds or withdraws tools')
      const tool = b['tool']
      if (!isObj(tool) || tool['type'] !== 'tool_reference' || typeof tool['name'] !== 'string' || !TOOL_NAME.test(tool['name'])) return refuse('a tool change names a tool')
      return { type: b['type'], tool: { type: 'tool_reference', name: tool['name'] } }
    }),
  }
}

// the ids of the server tool calls the history answers: a result block names its call, in the same reply or, when the
// provider ran the call at the start of the next one, in a later reply
function answeredCalls(raw: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const m of raw) {
    if (!isObj(m) || m['role'] !== 'assistant' || !Array.isArray(m['content'])) continue
    for (const b of m['content']) if (isObj(b) && typeof b['type'] === 'string' && b['type'].endsWith('_tool_result') && typeof b['tool_use_id'] === 'string') ids.add(b['tool_use_id'])
  }
  return ids
}

// A server tool call no block answers (a tool search streamed after a client tool call, in a reply that stopped for the
// client's call, kept by an app from before it left such calls out) is a 400 on every later request, so it is left out,
// and an assistant message it leaves empty with it.
function messages(raw: unknown): { list: Obj[]; unanswered: number } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) refuse('messages must be a list of 1 to 400')
  const answered = answeredCalls(raw as unknown[])
  let unanswered = 0
  const list: Obj[] = []
  for (const m of raw as unknown[]) {
    if (isObj(m) && m['role'] === 'system') {
      list.push(toolChange(m))
      continue
    }
    if (!isObj(m) || (m['role'] !== 'user' && m['role'] !== 'assistant')) return refuse('each message is from the user or the assistant')
    const role = m['role'] as string
    const c = m['content']
    if (typeof c === 'string') {
      list.push({ role, content: c })
      continue
    }
    if (!Array.isArray(c) || c.length === 0) return refuse('message content must be text or blocks')
    const kept = c.filter((b) => !(role === 'assistant' && isObj(b) && b['type'] === 'server_tool_use' && !(typeof b['id'] === 'string' && answered.has(b['id']))))
    unanswered += c.length - kept.length
    if (kept.length > 0) list.push({ role, content: kept.map((b) => block(b, role)) })
  }
  return { list, unanswered }
}

function system(raw: unknown): Obj[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'string') return [{ type: 'text', text: raw }]
  if (!Array.isArray(raw)) return refuse('system must be text')
  return raw.map((b) => (isObj(b) && b['type'] === 'text' ? textBlock(b) : refuse('system holds text blocks only')))
}

// keywords holding one subschema, a list of them, or a map of them
const ONE = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties']
const LIST = ['prefixItems', 'anyOf', 'oneOf', 'allOf']
const MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']

// draft-07 tuples (items as a list, from older kits) in the 2020-12 form the provider
// requires: prefixItems for the list, items for what follows it
function tuples(s: unknown): void {
  if (!isObj(s)) return
  if (Array.isArray(s['items'])) {
    const rest = s['additionalItems']
    s['prefixItems'] = s['items']
    delete s['items']
    delete s['additionalItems']
    if (rest !== undefined && rest !== true) s['items'] = rest
  }
  for (const k of ONE) tuples(s[k])
  for (const k of LIST) if (Array.isArray(s[k])) (s[k] as unknown[]).forEach(tuples)
  for (const k of MAP) if (isObj(s[k])) Object.values(s[k]).forEach(tuples)
}

function inputSchema(raw: Obj): Obj {
  const s = structuredClone(raw)
  // a draft-07 or older $schema line would have the rest read under that draft
  if (typeof s['$schema'] === 'string' && /json-schema\.org\/draft-0[0-7]\//.test(s['$schema'])) delete s['$schema']
  tuples(s)
  return s
}

function tools(raw: unknown): { list: Obj[]; searches: number } {
  if (raw === undefined) return { list: [], searches: 0 }
  if (!Array.isArray(raw) || raw.length > MAX_TOOLS) return refuse(`tools must be a list of at most ${MAX_TOOLS}`)
  let searches = 0
  const list = raw.map((t) => {
    if (!isObj(t)) return refuse('bad tool')
    if (typeof t['type'] === 'string' && Object.hasOwn(SEARCH_TOOLS, t['type'])) {
      // never deferred, and no cache point: the proxy places that on the last tool that loads
      if (t['name'] !== SEARCH_TOOLS[t['type']]) return refuse(`tool ${t['type']} goes by its own name`)
      return { type: t['type'], name: t['name'] }
    }
    if (typeof t['type'] === 'string' && t['type'] !== 'custom') {
      if (!t['type'].startsWith('web_search_')) return refuse(`tool ${t['type']} is not allowed`)
      // every web search tool counts toward the one limit
      const asked = typeof t['max_uses'] === 'number' && t['max_uses'] > 0 ? Math.floor(t['max_uses']) : MAX_SEARCHES
      const uses = Math.min(asked, MAX_SEARCHES - searches)
      if (uses < 1) return refuse(`at most ${MAX_SEARCHES} web searches a call`)
      searches += uses
      return { type: 'web_search_20250305', name: 'web_search', max_uses: uses }
    }
    if (typeof t['name'] !== 'string' || !TOOL_NAME.test(t['name'])) return refuse('bad tool name')
    if (!isObj(t['input_schema'])) return refuse('a tool needs an input schema')
    const out: Obj = { name: t['name'], input_schema: inputSchema(t['input_schema'] as Obj) }
    if (typeof t['description'] === 'string') out['description'] = t['description']
    if (t['strict'] === true) out['strict'] = true
    // a deferred tool loads only when a search finds it, and the provider refuses a cache point on one
    if (t['defer_loading'] === true) out['defer_loading'] = true
    else cachePoint(t, out)
    return out
  })
  const loaded = list.filter((t) => t['defer_loading'] !== true && !(typeof t['type'] === 'string' && Object.hasOwn(SEARCH_TOOLS, t['type']))).length
  if (loaded > MAX_LOADED_TOOLS) refuse(`at most ${MAX_LOADED_TOOLS} tools load up front; defer the rest behind tool search`)
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
  const lastTool = [...tl].reverse().find((t) => t['type'] === undefined && t['defer_loading'] !== true)
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

// prompt tokens, never under: a token for every byte of the request, and each image at the
// most an image can cost. Only the image blocks shape built count as images: an object
// shaped like one anywhere else (a tool's input or schema) is text, a token a byte.
function estimate(body: Obj): number {
  let images = 0
  const text = JSON.stringify(body, (_k, v) => {
    if (isObj(v) && IMAGES.has(v)) {
      images++
      return { type: 'image' }
    }
    return v
  })
  return new TextEncoder().encode(text).length + images * IMAGE_TOKENS + TOOL_OVERHEAD
}

function documentsIn(body: Obj): number {
  let n = 0
  for (const m of body['messages'] as Obj[]) if (Array.isArray(m['content'])) for (const b of m['content'] as Obj[]) if (DOCUMENTS.has(b)) n++
  return n
}

/**
 * The most prompt tokens a call can bill: one pass at the prompt without web search, and
 * with it one more pass per search, each carrying the reply so far and every search's
 * results.
 */
export function worstInput(prompt: number, maxOutput: number, searches: number): number {
  if (searches === 0) return Math.min(prompt, CONTEXT_TOKENS)
  return (searches + 1) * Math.min(prompt + maxOutput + searches * SEARCH_RESULT_TOKENS, CONTEXT_TOKENS)
}

/** The efforts a client may ask for; anything else is medium. */
const EFFORTS = new Set(['low', 'medium', 'high'])
/** Under this many output tokens a call the client did not ask to think goes without thinking, so it is not all thinking. */
export const SMALL_OUTPUT = 4000

/**
 * The thinking and effort for the routed model. A client that leaves thinking out gets adaptive thinking at its effort
 * (low, medium or high; medium otherwise), as every turn did before, unless its output limit is under SMALL_OUTPUT. A
 * client that sends {type: "disabled"}, or a small call that asks for no thinking, gets the model's own form of no
 * thinking, never a shape the model refuses: Haiku 5.5 takes disabled; Sonnet 5.5 takes between_tools alone; Opus 5.5
 * cannot turn thinking off, so it stays adaptive at effort low; any other model stays adaptive. A client that asks to
 * think (enabled, adaptive) gets adaptive.
 */
export function thinkingFor(model: string, thinking: unknown, outputConfig: unknown, maxOutput: number): Obj {
  const asked = isObj(outputConfig) && typeof outputConfig['effort'] === 'string' && EFFORTS.has(outputConfig['effort']) ? outputConfig['effort'] : 'medium'
  const type = isObj(thinking) ? thinking['type'] : undefined
  const off = type === 'disabled' || (thinking === undefined && maxOutput < SMALL_OUTPUT)
  if (off) {
    if (/^claude-haiku-5-5(-|$)/.test(model)) return { thinking: { type: 'disabled' }, output_config: { effort: asked } }
    if (/^claude-sonnet-5-5(-|$)/.test(model)) return { thinking: { type: 'between_tools' }, output_config: { effort: asked } }
    if (/^claude-opus-5-5(-|$)/.test(model)) return { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
  }
  return { thinking: { type: 'adaptive' }, output_config: { effort: asked } }
}

/** The betas the client asked for (its `anthropic-beta` header) that the proxy passes, in BETAS order. */
function betasOf(header: string | null | undefined): string[] {
  const asked = new Set((header ?? '').split(',').map((b) => b.trim()))
  return BETAS.filter((b) => asked.has(b))
}

/**
 * `model`: the turn's model, which the proxy picked (never the client's `model` field). `betas`: the client's
 * `anthropic-beta` header.
 */
export function shape(raw: unknown, model: string = MODEL, betas?: string | null): Shaped {
  try {
    if (!isObj(raw)) refuse('the body must be a JSON object')
    const r = raw as Obj
    const cap = maxOutputFor(model)
    const asked = typeof r['max_tokens'] === 'number' && r['max_tokens'] > 0 ? Math.floor(r['max_tokens']) : cap
    const maxOutput = Math.min(asked, cap)
    const t = tools(r['tools'])
    const m = messages(r['messages'])
    const body: Obj = { model, max_tokens: maxOutput, stream: true, messages: m.list }
    const sys = system(r['system'])
    if (sys) body['system'] = sys
    if (t.list.length > 0) {
      body['tools'] = t.list
      const choice = toolChoice(r['tool_choice'])
      if (choice) body['tool_choice'] = choice
    }
    Object.assign(body, thinkingFor(model, r['thinking'], r['output_config'], maxOutput))
    placeCache(body)
    return { ok: true, body, promptEstimate: estimate(body), maxOutput, maxSearches: t.searches, documents: documentsIn(body), betas: betasOf(betas), unanswered: m.unanswered }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message }
    throw e
  }
}
