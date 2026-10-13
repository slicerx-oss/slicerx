// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The proxy's request rules, its stream reading, and its routes against a fake database
// and a fake provider. Run with `deno test supabase/functions/mimir`.
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.13'
import { MAX_OUTPUT, MODEL, shape, worstInput } from './shape.ts'
import { StreamTap } from './usage.ts'
import { clientIp, type Env, handle, marked } from './handler.ts'
import geomCut from './geom_cut_0.1.4.json' with { type: 'json' }

type Obj = Record<string, unknown>
const TOOL = { name: 'design_box', description: 'A box.', input_schema: { type: 'object', properties: {} } }
const ok = (raw: unknown) => {
  const s = shape(raw)
  if (!s.ok) throw new Error(s.error)
  return s
}
const base = (extra: Obj = {}) => ({ messages: [{ role: 'user', content: 'a 20 mm cube' }], ...extra })

Deno.test('the model is pinned and the reply capped', () => {
  const s = ok(base({ model: 'claude-opus-5-5', max_tokens: 100000 }))
  assertEquals(s.body['model'], MODEL)
  assertEquals(s.body['max_tokens'], MAX_OUTPUT)
  assertEquals(s.body['stream'], true)
  assertEquals(ok(base({ max_tokens: 500 })).body['max_tokens'], 500)
})

Deno.test('thinking is adaptive whatever the client asks', () => {
  const s = ok(base({ thinking: { type: 'enabled', budget_tokens: 10000 } }))
  assertEquals(s.body['thinking'], { type: 'adaptive' })
  assertEquals(s.body['output_config'], { effort: 'medium' })
})

Deno.test('fields outside the allowlist are dropped', () => {
  const s = ok(base({ fallbacks: 'default', mcp_servers: [{ url: 'https://x' }], container: 'c', temperature: 1, metadata: { user_id: 'x' } }))
  for (const k of ['fallbacks', 'mcp_servers', 'container', 'temperature', 'metadata']) assert(!(k in s.body), k)
})

Deno.test('only client tools and web search pass, with searches capped', () => {
  const s = ok(base({ tools: [TOOL, { type: 'web_search_20260209', name: 'web_search', max_uses: 50, allowed_domains: ['x.com'] }] }))
  const tools = s.body['tools'] as Obj[]
  assertEquals(tools[1], { type: 'web_search_20250305', name: 'web_search', max_uses: 3 })
  assertEquals(s.maxSearches, 3)
  // every web search tool counts toward the one limit
  const two = ok(base({ tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }, { type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] }))
  assertEquals(two.maxSearches, 3)
  assertEquals((two.body['tools'] as Obj[]).map((t) => t['max_uses']), [2, 1])
  assert(!shape(base({ tools: [{ type: 'web_search_20250305', name: 'web_search' }, { type: 'web_search_20250305', name: 'web_search' }] })).ok)
  for (const t of ['code_execution_20260521', 'web_fetch_20260209', 'computer_toolset_20260801', 'bash_20250124', 'mcp_toolset']) {
    const r = shape(base({ tools: [{ type: t, name: 'x' }] }))
    assert(!r.ok, t)
  }
  assert(!shape(base({ tools: [{ name: 'bad name!', input_schema: {} }] })).ok)
})

// slicerx_geom_cut's input schema as @slicerx/mcp 0.1.4 lists it: draft-07 tuples
const GEOM_CUT: Obj = geomCut
const VEC3 = { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }, { type: 'number' }], items: false, minItems: 3, maxItems: 3 }
const schemaOf = (input_schema: Obj) => (ok(base({ tools: [{ name: 'slicerx_geom_cut', input_schema }] })).body['tools'] as Obj[])[0]!['input_schema'] as Obj

Deno.test('draft-07 tuples go out as 2020-12 prefixItems', () => {
  const sent = structuredClone(GEOM_CUT)
  const s = schemaOf(sent)
  assertEquals(sent, GEOM_CUT)
  assert(!('$schema' in s))
  const plane = (s['properties'] as Obj)['plane'] as Obj
  const byPoint = (plane['anyOf'] as Obj[])[1]!['properties'] as Obj
  assertEquals(byPoint['point'], VEC3)
  assertEquals(byPoint['normal'], VEC3)
  assert(!JSON.stringify(s).includes('additionalItems'))
  // the rest of the schema is as sent
  const { $schema: _, ...rest } = structuredClone(GEOM_CUT) as Obj
  ;((((rest['properties'] as Obj)['plane'] as Obj)['anyOf'] as Obj[])[1]!['properties'] as Obj)['point'] = VEC3
  ;((((rest['properties'] as Obj)['plane'] as Obj)['anyOf'] as Obj[])[1]!['properties'] as Obj)['normal'] = VEC3
  assertEquals(s, rest)
})

Deno.test('nested tuples are rewritten at every depth', () => {
  const num = { type: 'number' }
  const pair = { type: 'array', items: [num, num], additionalItems: false }
  const s = schemaOf({
    type: 'object',
    properties: {
      loops: { type: 'array', items: { type: 'array', items: pair } },
      seg: { type: 'array', items: [pair, pair], additionalItems: { type: 'string' } },
      open: { type: 'array', items: [num], additionalItems: true },
      either: { oneOf: [pair, { allOf: [{ not: pair }] }] },
      map: { type: 'object', additionalProperties: pair },
    },
    $defs: { p: pair },
    definitions: { p: pair },
  })
  const p2 = { type: 'array', prefixItems: [num, num], items: false }
  assertEquals(s['properties'], {
    loops: { type: 'array', items: { type: 'array', items: p2 } },
    seg: { type: 'array', prefixItems: [p2, p2], items: { type: 'string' } },
    open: { type: 'array', prefixItems: [num] },
    either: { oneOf: [p2, { allOf: [{ not: p2 }] }] },
    map: { type: 'object', additionalProperties: p2 },
  })
  assertEquals(s['$defs'], { p: p2 })
  assertEquals(s['definitions'], { p: p2 })
})

Deno.test('a schema without tuples passes unchanged', () => {
  const plain = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'string' } }, additionalItems: { type: 'number' }, n: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
    required: ['items'],
    additionalProperties: false,
  }
  assertEquals(schemaOf(structuredClone(plain)), plain)
})

Deno.test('cache points go on the last tool and system block, and the tail', () => {
  const s = ok(base({ tools: [TOOL, { ...TOOL, name: 'design_cyl' }], system: 'You are mimir.' }))
  const tools = s.body['tools'] as Obj[]
  assertEquals(tools[0]!['cache_control'], undefined)
  assertEquals(tools[1]!['cache_control'], { type: 'ephemeral' })
  assertEquals((s.body['system'] as Obj[])[0]!['cache_control'], { type: 'ephemeral' })
  assertEquals(s.body['cache_control'], { type: 'ephemeral' })
})

Deno.test('client cache points are kept in 5-minute form and held to four', () => {
  const marked = { type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }
  const s = ok({
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [1, 2, 3, 4, 5].map(() => ({ role: 'user', content: [marked] })),
  })
  assertEquals((s.body['system'] as Obj[])[0]!['cache_control'], { type: 'ephemeral' })
  const n = (s.body['messages'] as Obj[]).filter((m) => (m['content'] as Obj[])[0]!['cache_control']).length
  assertEquals(n, 3)
  assertEquals(s.body['cache_control'], undefined)
})

Deno.test('replayed history keeps no long cache points', () => {
  const s = ok({
    messages: [
      { role: 'user', content: 'look it up' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 's', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'web_search_tool_result', tool_use_id: 'w1', content: [{ type: 'web_search_result', url: 'https://x', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        ],
      },
    ],
  })
  const a = (s.body['messages'] as Obj[])[1]!['content'] as Obj[]
  assertEquals(a[0]!['cache_control'], { type: 'ephemeral' })
  assertEquals((a[1]!['content'] as Obj[])[0]!['cache_control'], undefined)
  assert(!JSON.stringify(s.body).includes('1h'))
})

Deno.test('the estimate never undercounts: a token a byte, images at their most, searches in full', () => {
  const text = 'x'.repeat(10_000)
  assert(ok(base({ messages: [{ role: 'user', content: text }] })).promptEstimate >= 10_000)
  // a field named data that is not an image counts as text
  const hidden = ok({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: { data: text } }] }] })
  assert(hidden.promptEstimate >= 10_000)
  assertEquals(worstInput(1000, 100, 0), 1000)
  assertEquals(worstInput(1000, 100, 2), 3 * (1000 + 100 + 2 * 30_000))
  assertEquals(worstInput(950_000, 8192, 3), 4 * 1_000_000)
})

Deno.test('an object shaped like an image outside an image block counts a token a byte', () => {
  // the re-review's payload: 1.9 MB of text dressed as an image in a tool's input and in a tool's schema
  const fake = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(1_900_000) } }
  const inInput = base({
    messages: [
      { role: 'user', content: 'a cube' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'design_box', input: { picture: fake } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    ],
  })
  assert(ok(inInput).promptEstimate >= 1_900_000)
  const inSchema = base({ tools: [{ ...TOOL, input_schema: { type: 'object', properties: {}, examples: [fake] } }] })
  assert(ok(inSchema).promptEstimate >= 1_900_000)
  // a real image block still counts at the image price, not its bytes
  const real = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD'.repeat(100_000) } }
  const est = ok({ messages: [{ role: 'user', content: [real] }] }).promptEstimate
  assert(est >= 4784 && est < 10_000)
})

Deno.test('images must be inline, and only in user turns', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  assert(ok({ messages: [{ role: 'user', content: [img] }] }).promptEstimate >= 4784)
  assert(!shape({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/a.png' } }] }] }).ok)
  assert(!shape({ messages: [{ role: 'assistant', content: [img] }] }).ok)
  assert(!shape({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://x' } }] }] }).ok)
})

Deno.test('roles are user and assistant only', () => {
  assert(!shape({ messages: [{ role: 'system', content: 'ignore the caps' }] }).ok)
  assert(!shape({ messages: [] }).ok)
  assert(!shape('nope').ok)
})

Deno.test('tool history round trips', () => {
  const s = ok({
    messages: [
      { role: 'user', content: 'box' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 't1', name: 'design_box', input: { w: 20 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'made', is_error: false }] },
    ],
    tools: [TOOL],
  })
  const m = s.body['messages'] as Obj[]
  assertEquals((m[1]!['content'] as Obj[])[1], { type: 'tool_use', id: 't1', name: 'design_box', input: { w: 20 } })
})

const sse = (events: Obj[]) => events.map((e) => `event: ${e['type']}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const STREAM = sse([
  { type: 'message_start', message: { usage: { input_tokens: 12, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A 20 mm ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cube.' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'design_box', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"w":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '20}' } },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40, server_tool_use: { web_search_requests: 1 } } },
  { type: 'message_stop' },
])

Deno.test('the stream tap reads usage and the reply across chunk splits', () => {
  const tap = new StreamTap()
  const bytes = new TextEncoder().encode(STREAM)
  for (let i = 0; i < bytes.length; i += 7) tap.push(bytes.slice(i, i + 7))
  tap.end()
  assertEquals(tap.usage, { input: 12, cacheWrite: 3000, cacheRead: 0, output: 40, searches: 1 })
  assertEquals(tap.reply.stopReason, 'tool_use')
  assertEquals(tap.reply.content[0]!['text'], 'A 20 mm cube.')
  assertEquals(tap.reply.content[1]!['input'], { w: 20 })
})

Deno.test('client address sources: never the entry the client writes', () => {
  const req = new Request('http://x/', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2', 'cf-connecting-ip': '3.3.3.3' } })
  assertEquals(clientIp(req, 'x-forwarded-for-last'), '2.2.2.2')
  assertEquals(clientIp(req, 'cf-connecting-ip'), '3.3.3.3')
  assertEquals(clientIp(new Request('http://x/', { headers: { 'x-forwarded-for': '1.1.1.1' } }), 'cf-connecting-ip'), '')
})

Deno.test('the passed-on stream folds cache counts into the input count', () => {
  const tap = new StreamTap()
  const out = tap.push(new TextEncoder().encode(STREAM)) + tap.end()
  assertEquals(tap.usage.cacheWrite, 3000)
  assert(out.includes('"input_tokens":3012'))
  assert(!/"cache_creation_input_tokens":[1-9]/.test(out))
  assert(out.includes('A 20 mm '))
  assert(tap.complete && !tap.failed)
})

// A fake database and provider, recording what reaches them.
function harness(opts: { reserve?: (args: Obj) => Response; upstream?: () => Response; count?: () => Response } = {}) {
  const calls: { fn: string; args: Obj }[] = []
  const sent: { url: string; headers: Headers; body: Obj }[] = []
  const pending: Promise<unknown>[] = []
  const env: Env = {
    supabaseUrl: 'http://db',
    serviceKey: 'service',
    anthropicKey: 'sk-ant-test',
    upstream: 'http://provider',
    ipSource: 'cf-connecting-ip',
    waitUntil: (p) => pending.push(p),
    fetch: async (input, rawInit) => {
      const init = rawInit as { body?: unknown; headers?: HeadersInit } | undefined
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Obj
      if (url.startsWith('http://db/rest/v1/rpc/')) {
        const fn = url.slice('http://db/rest/v1/rpc/'.length)
        calls.push({ fn, args: body })
        if (fn === 'mimir_reserve') return opts.reserve?.(body) ?? Response.json('11111111-1111-1111-1111-111111111111')
        if (fn === 'mimir_register') return Response.json([{ install_id: 'i1', token: 'f'.repeat(64) }])
        if (fn === 'mimir_forget') return Response.json(2)
        return Response.json(null)
      }
      sent.push({ url, headers: new Headers(init?.headers), body })
      if (url.endsWith('/count_tokens')) return opts.count?.() ?? Response.json({ input_tokens: 10 })
      return opts.upstream?.() ?? new Response(STREAM, { headers: { 'content-type': 'text/event-stream' } })
    },
  }
  return { env, calls, sent, pending }
}
const TOKEN = 'a'.repeat(64)
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://fn/functions/v1/mimir${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9', ...headers },
    body: JSON.stringify(body),
  })

Deno.test('a call reserves, streams through, and settles what it used', async () => {
  const h = harness()
  const res = await handle(post('/v1/messages', base({ tools: [TOOL] }), { 'x-sx-install': TOKEN }), h.env)
  assertEquals(res.status, 200)
  assertMatch(await res.text(), /A 20 mm /)
  await Promise.all(h.pending)
  assertEquals(h.calls.map((c) => c.fn), ['mimir_reserve', 'mimir_settle'])
  assertEquals(h.calls[0]!.args['p_ip'], '9.9.9.9')
  assertEquals(h.calls[0]!.args['p_output'], MAX_OUTPUT)
  assertEquals(h.calls[0]!.args['p_input'], ok(base({ tools: [TOOL] })).promptEstimate)
  assertEquals(h.calls[1]!.args, {
    p_call: '11111111-1111-1111-1111-111111111111', p_model: MODEL, p_input: 12, p_cache_write: 3000, p_cache_read: 0, p_output: 40, p_searches: 1,
  })
  assertEquals(h.sent[0]!.url, 'http://provider/v1/messages')
  assertEquals(h.sent[0]!.headers.get('x-api-key'), 'sk-ant-test')
  assertEquals(h.sent[0]!.body['model'], MODEL)
})

Deno.test('the client never sets provider headers', async () => {
  const h = harness()
  await handle(post('/v1/messages', base(), { 'x-sx-install': TOKEN, 'anthropic-beta': 'server-side-fallback-2026-07-01', 'x-api-key': 'sk-ant-theirs' }), h.env)
  assertEquals(h.sent[0]!.headers.get('anthropic-beta'), null)
  assertEquals(h.sent[0]!.headers.get('x-api-key'), 'sk-ant-test')
})

Deno.test('shared sessions are stored without image data, and only when shared', async () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD'.repeat(100) } }
  const msg = { messages: [{ role: 'user', content: [img, { type: 'text', text: 'like this' }] }] }
  const h = harness()
  const res = await handle(post('/v1/messages', msg, { 'x-sx-install': TOKEN, 'x-sx-share': '1', 'x-sx-session': 's-1', 'x-sx-version': '0.2.0' }), h.env)
  await res.text()
  await Promise.all(h.pending)
  const stored = h.calls.find((c) => c.fn === 'mimir_store_session')!
  assertEquals(stored.args['p_session_key'], 's-1')
  const text = JSON.stringify(stored.args['p_transcript'])
  assert(!text.includes('QUJD'))
  assertMatch(text, /\[image, 400 base64 chars\]/)
  assertMatch(text, /A 20 mm cube\./)

  const off = harness()
  await (await handle(post('/v1/messages', msg, { 'x-sx-install': TOKEN, 'x-sx-session': 's-1', 'x-sx-version': '0.2.0' }), off.env)).text()
  await Promise.all(off.pending)
  assert(!off.calls.some((c) => c.fn === 'mimir_store_session'))
})

Deno.test('a failed, refused or cut-short call stores no session', async () => {
  const shared = { 'x-sx-install': TOKEN, 'x-sx-share': '1', 'x-sx-session': 's-1', 'x-sx-version': '0.2.0' }
  const streams = [
    sse([{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]),
    sse([{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]),
  ]
  for (const stream of streams) {
    const h = harness({ upstream: () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) })
    await (await handle(post('/v1/messages', base(), shared), h.env)).text()
    await Promise.all(h.pending)
    // an unfinished stream may have billed more than it counted: it settles at the whole allowance
    assertEquals(h.calls.find((c) => c.fn === 'mimir_settle')!.args['p_output'], MAX_OUTPUT)
    assert(!h.calls.some((c) => c.fn === 'mimir_store_session'))
  }
  // only an invalid request's reason goes back to the caller; anything else about our account stays here
  const refused = harness({ upstream: () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'secret detail' } }, { status: 401 }) })
  const res = await handle(post('/v1/messages', base(), shared), refused.env)
  assertEquals(res.status, 502)
  assert(!(await res.text()).includes('secret detail'), 'the provider\'s words stay on the server')
  await Promise.all(refused.pending)
  assert(!refused.calls.some((c) => c.fn === 'mimir_store_session'))
})

Deno.test('a turn over 256 KB is not stored', async () => {
  const h = harness()
  const big = { messages: [{ role: 'user', content: 'x'.repeat(300_000) }] }
  await (await handle(post('/v1/messages', big, { 'x-sx-install': TOKEN, 'x-sx-share': '1', 'x-sx-session': 's-1', 'x-sx-version': '0.2.0' }), h.env)).text()
  await Promise.all(h.pending)
  assert(!h.calls.some((c) => c.fn === 'mimir_store_session'))
})

Deno.test('when the byte estimate hits a daily cap, the exact count gets one more try', async () => {
  let n = 0
  const h = harness({
    reserve: () => (n++ === 0 ? Response.json({ message: 'daily limit', hint: 'install_daily' }, { status: 400 }) : Response.json('22222222-2222-2222-2222-222222222222')),
  })
  const res = await handle(post('/v1/messages', base(), { 'x-sx-install': TOKEN }), h.env)
  assertEquals(res.status, 200)
  await res.text()
  const reserves = h.calls.filter((c) => c.fn === 'mimir_reserve')
  assertEquals(reserves.length, 2)
  assertEquals(reserves[1]!.args['p_input'], 10)
  assert(h.sent.some((x) => x.url.endsWith('/count_tokens')))
  // other refusals are final, a network that used its day before this call among them
  for (const hint of ['install_busy', 'net_busy', 'net_full']) {
    const busy = harness({ reserve: () => Response.json({ message: 'no', hint }, { status: 400 }) })
    assertEquals((await handle(post('/v1/messages', base(), { 'x-sx-install': TOKEN }), busy.env)).status, 429, hint)
    assert(!busy.sent.length, hint)
    assertEquals(busy.calls.filter((c) => c.fn === 'mimir_reserve').length, 1, hint)
  }
})

Deno.test('a refused call counts toward the rates, once per request', async () => {
  for (const hint of ['install_daily', 'ip_busy', 'edition_busy']) {
    const h = harness({ reserve: () => Response.json({ message: 'no', hint }, { status: 400 }) })
    assertEquals((await handle(post('/v1/messages', base(), { 'x-sx-install': TOKEN }), h.env)).status, hint === 'edition_busy' ? 503 : 429)
    assertEquals(h.calls.filter((c) => c.fn === 'mimir_refused').map((c) => c.args), [{ p_token: TOKEN, p_ip: '9.9.9.9' }], hint)
  }
  // a rate refusal comes only while the window is full, and an unknown install has no rate
  for (const hint of ['install_rate', 'ip_rate', 'unknown_install']) {
    const h = harness({ reserve: () => Response.json({ message: 'no', hint }, { status: 400 }) })
    await handle(post('/v1/messages', base(), { 'x-sx-install': TOKEN }), h.env)
    assert(!h.calls.some((c) => c.fn === 'mimir_refused'), hint)
  }
})

Deno.test('each install caches apart: a mark after the shared tools and system prompt', async () => {
  const sys = { system: [{ type: 'text', text: 'You are mimir.' }], tools: [TOOL] }
  const one = harness()
  await (await handle(post('/v1/messages', base(sys), { 'x-sx-install': TOKEN }), one.env)).text()
  await (await handle(post('/v1/messages', base(sys), { 'x-sx-install': TOKEN }), one.env)).text()
  const other = harness()
  await (await handle(post('/v1/messages', base(sys), { 'x-sx-install': 'b'.repeat(64) }), other.env)).text()
  const system = (x: { body: Obj }) => x.body['system'] as Obj[]
  const [a1, a2] = one.sent.map(system)
  const b = system(other.sent[0]!)
  assertEquals(a1!.length, 2)
  // the shared prefix keeps its cache point; the mark comes after it, the same for one install
  assertEquals(a1![0], { type: 'text', text: 'You are mimir.', cache_control: { type: 'ephemeral' } })
  assertMatch(String(a1![1]!['text']), /^scope [0-9a-f]{16}$/)
  assertEquals(a1![1], a2![1])
  assert(a1![1]!['text'] !== b![1]!['text'])
  assertEquals(marked({ messages: [] }, 'ab')['system'], [{ type: 'text', text: 'scope ab' }])
})

Deno.test('a cap answers 429 with its reason and never reaches the provider', async () => {
  const h = harness({ reserve: () => Response.json({ message: 'daily limit', hint: 'install_daily' }, { status: 400 }) })
  const res = await handle(post('/v1/messages', base(), { 'x-sx-install': TOKEN }), h.env)
  assertEquals(res.status, 429)
  const body = (await res.json()) as { error: Obj }
  assertEquals(body.error['reason'], 'install_daily')
  assertMatch(String(body.error['message']), /midnight Melbourne time/)
  assert(!h.sent.some((x) => x.url.endsWith('/v1/messages')), 'nothing reaches the model')
})

Deno.test('requests without a token, too large, or refused never reach the database', async () => {
  const h = harness()
  assertEquals((await handle(post('/v1/messages', base()), h.env)).status, 401)
  assertEquals((await handle(post('/v1/messages', base(), { 'x-sx-install': 'short' }), h.env)).status, 401)
  const big = { messages: [{ role: 'user', content: 'x'.repeat(2_100_000) }] }
  assertEquals((await handle(post('/v1/messages', big, { 'x-sx-install': TOKEN }), h.env)).status, 413)
  const noIp = new Request('http://fn/functions/v1/mimir/v1/messages', { method: 'POST', headers: { 'x-sx-install': TOKEN, 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(base()) })
  assertEquals((await handle(noIp, h.env)).status, 400)
  assertEquals((await handle(post('/v1/messages', base({ tools: [{ type: 'web_fetch_20260209', name: 'web_fetch' }] }), { 'x-sx-install': TOKEN }), h.env)).status, 400)
  assertEquals(h.calls.length, 0)
})

Deno.test('a provider failure settles at nothing and says so plainly', async () => {
  const h = harness({ upstream: () => Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, { status: 529 }) })
  const res = await handle(post('/v1/messages', base(), { 'x-sx-install': TOKEN }), h.env)
  assertEquals(res.status, 503)
  await Promise.all(h.pending)
  assertEquals(h.calls.find((c) => c.fn === 'mimir_settle')!.args['p_output'], 0)
})

Deno.test('a refused call logs the provider status and error, never the key or the prompt', async () => {
  const logged: string[] = []
  const was = console.error
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '))
  try {
    const h = harness({ upstream: () => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'tools.3.custom.input_schema: bad' } }, { status: 400 }) })
    const res = await handle(post('/v1/messages', base(), { 'x-sx-install': TOKEN }), h.env)
    // the caller gets the provider's reason too, so a bad tool schema is fixable from the client
    assertEquals(res.status, 400)
    assertEquals((await res.json()).error, { type: 'invalid_request_error', message: 'The model provider refused the request: tools.3.custom.input_schema: bad' })
    await Promise.all(h.pending)
  } finally {
    console.error = was
  }
  const line = logged.find((l) => l.startsWith('mimir upstream:'))
  assertEquals(line, 'mimir upstream: 400 invalid_request_error: tools.3.custom.input_schema: bad')
  assert(!logged.join('\n').includes('sk-ant'), 'no key in the log')
  assert(!logged.join('\n').includes(JSON.stringify(base().messages)), 'no prompt in the log')
})

Deno.test('register, quota and forget', async () => {
  const h = harness()
  const key = 'layermate-build-key-1'
  const r = await handle(post('/register', { edition: 'layermate', key }), h.env)
  assertEquals(await r.json(), { install: 'i1', token: 'f'.repeat(64) })
  assertEquals(h.calls[0]!.args, { p_edition: 'layermate', p_ip: '9.9.9.9', p_key: key })
  assertEquals((await handle(post('/register', { edition: 'Bad Edition', key }), h.env)).status, 400)
  assertEquals((await handle(post('/register', { edition: 'layermate' }), h.env)).status, 403)
  assertEquals((await handle(post('/register', { edition: 'layermate', key, pad: 'x'.repeat(5000) }), h.env)).status, 413)
  assertEquals(h.calls.length, 1)
  const f = await handle(post('/forget', {}, { 'x-sx-install': TOKEN }), h.env)
  assertEquals(await f.json(), { deleted: 2 })
  assertEquals((await handle(new Request('http://fn/functions/v1/mimir/nope'), h.env)).status, 404)
})
