// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir proxy end to end on the local stack: the real function and database, with a
// fake provider on MOCK_PORT. integration.sh starts everything and runs this.
// Checks register, a streamed call settled at its real cost, the share switch, quota,
// a cap answering 429, and forget.
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const FN = process.env.MIMIR_FN ?? 'http://127.0.0.1:54321/functions/v1/mimir'
const DB = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_slicerx'
const PORT = Number(process.env.MOCK_PORT ?? 54399)

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const STREAM = sse([
  { type: 'message_start', message: { usage: { input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A 20 mm cube.' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1000 } },
  { type: 'message_stop' },
])

const seen = []
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({ headers: req.headers, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(STREAM)
  })
})
await new Promise((r) => mock.listen(PORT, '0.0.0.0', r))

const sql = (q) => execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-tA', '-c', q], { encoding: 'utf8' }).trim()
const call = (path, { method = 'POST', body, headers = {} } = {}) =>
  fetch(`${FN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const settled = async (n) => {
  for (let i = 0; i < 50; i++) {
    if (Number(sql('select count(*) from public.mimir_calls where settled_at is not null')) >= n) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('calls did not settle')
}

try {
  sql('delete from public.mimir_sessions; delete from public.mimir_calls; delete from public.mimir_installs')

  const reg = await call('/register', { body: { edition: 'slicerx' } })
  const regBody = await reg.text()
  assert.equal(reg.status, 200, regBody)
  const { token } = JSON.parse(regBody)
  assert.match(token, /^[0-9a-f]{64}$/)
  const auth = { 'x-sx-install': token }

  const msg = { model: 'claude-opus-5-5', max_tokens: 64000, system: 'You are mimir.', messages: [{ role: 'user', content: 'a 20 mm cube' }] }
  const r1 = await call('/v1/messages', { body: msg, headers: { ...auth, 'x-sx-share': '1', 'x-sx-session': 'it-1', 'x-sx-version': '0.2.0' } })
  const t1 = await r1.text()
  assert.equal(r1.status, 200, t1)
  assert.match(t1, /A 20 mm cube\./)
  await settled(1)
  const up = seen[0]
  assert.equal(up.headers['x-api-key'], 'sk-ant-integration')
  assert.equal(up.body.model, 'claude-haiku-5-5')
  assert.equal(up.body.max_tokens, 8192)
  assert.deepEqual(up.body.system[0].cache_control, { type: 'ephemeral' })
  // 100000 input at $0.10/M plus 1000 output at $0.50/M
  assert.equal(sql('select cost_micros from public.mimir_calls'), '10500')
  assert.equal(sql("select transcript->'reply'->'content'->0->>'text' from public.mimir_sessions where session_key = 'it-1'"), 'A 20 mm cube.')

  const r2 = await call('/v1/messages', { body: msg, headers: { ...auth, 'x-sx-session': 'it-2', 'x-sx-version': '0.2.0' } })
  await r2.text()
  await settled(2)
  assert.equal(sql("select count(*) from public.mimir_sessions where session_key = 'it-2'"), '0', 'sharing off stores nothing')

  const q = await (await call('/quota', { method: 'GET', headers: auth })).json()
  assert.equal(q.edition, 'slicerx')
  assert.equal(q.install_used, 21000)
  assert.equal(q.install_cap, 500000)

  sql("update public.mimir_limits set install_daily_micros = 21000 where edition = 'slicerx'")
  const capped = await call('/v1/messages', { body: msg, headers: auth })
  assert.equal(capped.status, 429)
  assert.equal((await capped.json()).error.reason, 'install_daily')
  assert.equal(seen.length, 2, 'a capped call never reaches the provider')

  const f = await call('/forget', { headers: auth })
  assert.deepEqual(await f.json(), { deleted: 1 })
  assert.equal((await call('/v1/messages', { body: msg, headers: { 'x-sx-install': '0'.repeat(64) } })).status, 401)
  console.log('mimir proxy integration: ok')
} finally {
  sql("update public.mimir_limits set install_daily_micros = 500000 where edition = 'slicerx'")
  mock.close()
}
