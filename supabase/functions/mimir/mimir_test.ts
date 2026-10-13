// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The proxy's request rules, its stream reading, and its routes against a fake database
// and a fake provider. Run with `deno test supabase/functions/mimir`.
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.13'
import { MAX_OUTPUT, MODEL, shape } from './shape.ts'
import { StreamTap } from './usage.ts'
import { clientIp, type Env, handle } from './handler.ts'

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
  for (const t of ['code_execution_20260521', 'web_fetch_20260209', 'computer_toolset_20260801', 'bash_20250124', 'mcp_toolset']) {
    const r = shape(base({ tools: [{ type: t, name: 'x' }] }))
    assert(!r.ok, t)
  }
  assert(!shape(base({ tools: [{ name: 'bad name!', input_schema: {} }] })).ok)
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

Deno.test('images must be inline, and only in user turns', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  assert(ok({ messages: [{ role: 'user', content: [img] }] }).inputEstimate >= 2000)
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

Deno.test('client address sources', () => {
  const req = new Request('http://x/', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2', 'cf-connecting-ip': '3.3.3.3' } })
  assertEquals(clientIp(req, 'x-forwarded-for-first'), '1.1.1.1')
  assertEquals(clientIp(req, 'x-forwarded-for-last'), '2.2.2.2')
  assertEquals(clientIp(req, 'cf-connecting-ip'), '3.3.3.3')
})

// A fake database and provider, recording what reaches them.
function harness(opts: { reserve?: (args: Obj) => Response; upstream?: () => Response } = {}) {
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
  assertEquals(await res.text(), STREAM)
  await Promise.all(h.pending)
  assertEquals(h.calls.map((c) => c.fn), ['mimir_reserve', 'mimir_settle'])
  assertEquals(h.calls[0]!.args['p_ip'], '9.9.9.9')
  assertEquals(h.calls[0]!.args['p_output'], MAX_OUTPUT)
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

Deno.test('a cap answers 429 with its reason and never reaches the provider', async () => {
  const h = harness({ reserve: () => Response.json({ message: 'daily limit', hint: 'install_daily' }, { status: 400 }) })
  const res = await handle(post('/v1/messages', base(), { 'x-sx-install': TOKEN }), h.env)
  assertEquals(res.status, 429)
  const body = (await res.json()) as { error: Obj }
  assertEquals(body.error['reason'], 'install_daily')
  assertMatch(String(body.error['message']), /midnight Melbourne time/)
  assertEquals(h.sent.length, 0)
})

Deno.test('requests without a token, too large, or refused never reach the database', async () => {
  const h = harness()
  assertEquals((await handle(post('/v1/messages', base()), h.env)).status, 401)
  assertEquals((await handle(post('/v1/messages', base(), { 'x-sx-install': 'short' }), h.env)).status, 401)
  const big = { messages: [{ role: 'user', content: 'x'.repeat(2_100_000) }] }
  assertEquals((await handle(post('/v1/messages', big, { 'x-sx-install': TOKEN }), h.env)).status, 413)
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

Deno.test('register, quota and forget', async () => {
  const h = harness()
  const r = await handle(post('/register', { edition: 'layermate' }), h.env)
  assertEquals(await r.json(), { install: 'i1', token: 'f'.repeat(64) })
  assertEquals(h.calls[0]!.args, { p_edition: 'layermate', p_ip: '9.9.9.9' })
  assertEquals((await handle(post('/register', { edition: 'Bad Edition' }), h.env)).status, 400)
  const f = await handle(post('/forget', {}, { 'x-sx-install': TOKEN }), h.env)
  assertEquals(await f.json(), { deleted: 2 })
  assertEquals((await handle(new Request('http://fn/functions/v1/mimir/nope'), h.env)).status, 404)
})
