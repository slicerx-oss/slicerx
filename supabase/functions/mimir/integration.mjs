// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir proxy end to end on the local stack: the real function and database, with a
// fake provider on MOCK_PORT. integration.sh starts everything and runs this.
// Checks register with the edition's key, a streamed call settled at its real cost, the
// share switch, quota, a cap answering 429, concurrent calls that never pass the cap, the
// in-flight limit, the exact count when the byte estimate is too high, two session stores
// at once that never pass the install's daily bytes, and forget.
import { createServer } from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
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

// a small call, for the concurrency checks
const SMALL = sse([
  { type: 'message_start', message: { usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
  { type: 'message_stop' },
])

const seen = []
const counted = []
// slow: answer SMALL after this many ms instead of STREAM at once
let slow = 0
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url.endsWith('/count_tokens')) {
      counted.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 10 }))
      return
    }
    seen.push({ headers: req.headers, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (slow) setTimeout(() => res.end(SMALL), slow)
    else res.end(STREAM)
  })
})
await new Promise((r) => mock.listen(PORT, '0.0.0.0', r))

const sql = (q) => execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-tA', '-c', q], { encoding: 'utf8' }).trim()
const call = (path, { method = 'POST', body, headers = {} } = {}) =>
  fetch(`${FN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const settled = async (n) => {
  for (let i = 0; i < 50; i++) {
    if (Number(sql('select count(*) from public.mimir_calls where settled_at is not null')) >= n) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('calls did not settle')
}
const KEY = 'integration-key-slicerx'
// back to the seeds (0022, 0023): $1 an install, $5 for SlicerX's day, open calls at $0.05
const RESET = "update public.mimir_limits set install_daily_micros = 1000000, edition_daily_micros = 5000000, install_call_micros = 50000, install_in_flight = 3, register_key_hash = null where edition = 'slicerx'"

try {
  sql('delete from public.mimir_sessions; delete from public.mimir_calls; delete from public.mimir_installs')
  sql(`update public.mimir_limits set register_key_hash = public.mimir_token_hash('${KEY}') where edition = 'slicerx'`)
  // the caps these numbers were written for: $0.50 an install, $20 for the day, open calls counted in full
  // (the clamp has its own pgTAP files)
  sql("update public.mimir_limits set install_daily_micros = 500000, edition_daily_micros = 20000000, install_call_micros = 1000000000 where edition = 'slicerx'")

  assert.equal((await call('/register', { body: { edition: 'slicerx', key: 'not-the-build-key' } })).status, 403, 'a wrong key cannot register')
  assert.equal((await call('/register', { body: { edition: 'slicerx' } })).status, 403, 'no key cannot register')
  const reg = await call('/register', { body: { edition: 'slicerx', key: KEY } })
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

  const r2 = await call('/v1/messages', { body: msg, headers: { ...auth, 'x-sx-share': '0', 'x-sx-session': 'it-2', 'x-sx-version': '0.2.0' } })
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
  const noIp = await fetch(`${FN}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(msg) })
  assert.equal(noIp.status, 400, 'a request without an address is refused')

  // Concurrent calls never pass the cap. A fresh install on its own address; each call
  // reserves its worst case, so two fit and the rest are refused while those two are open.
  const reg2 = await (await call('/register', { body: { edition: 'slicerx', key: KEY }, headers: { 'cf-connecting-ip': '203.0.113.9' } })).json()
  const auth2 = { 'x-sx-install': reg2.token, 'cf-connecting-ip': '203.0.113.9' }
  const small = { system: 'You are mimir.', max_tokens: 8192, messages: [{ role: 'user', content: 'a 20 mm cube' }] }
  const install2 = `(select id from public.mimir_installs where token_hash = public.mimir_token_hash('${reg2.token}'))`
  const spent = () => Number(sql(`select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls where install_id = ${install2}`))
  await (await call('/v1/messages', { body: small, headers: auth2 })).text()
  await settled(3)
  const worst = Number(sql(`select reserved_micros from public.mimir_calls where install_id = ${install2}`))
  const cap = spent() + 2 * worst + Math.floor(worst / 2)
  sql(`update public.mimir_limits set install_daily_micros = ${cap}, install_in_flight = 20 where edition = 'slicerx'`)
  const before = seen.length
  slow = 1500
  const burst = await Promise.all(Array.from({ length: 8 }, () => call('/v1/messages', { body: small, headers: auth2 })))
  const codes = burst.map((r) => r.status).sort()
  await Promise.all(burst.map((r) => r.text()))
  assert.deepEqual(codes, [200, 200, 429, 429, 429, 429, 429, 429], `burst answered ${codes}`)
  assert.equal(seen.length - before, 2, 'only the calls that fit reach the provider')
  await settled(5)
  assert.ok(spent() <= cap, 'what the install spent stays under its cap')

  // the in-flight limit: one call at a time
  sql(`update public.mimir_limits set install_daily_micros = 500000, install_in_flight = 1 where edition = 'slicerx'`)
  const busy = await Promise.all(Array.from({ length: 3 }, () => call('/v1/messages', { body: small, headers: auth2 })))
  const busyBodies = await Promise.all(busy.map((r) => r.json().catch(() => null)))
  assert.deepEqual(busy.map((r) => r.status).sort(), [200, 429, 429])
  assert.equal(busyBodies.filter((b) => b?.error?.reason === 'install_busy').length, 2)
  await settled(6)
  slow = 0

  // The byte estimate is refused when little is left; the exact count gets the call through.
  const tiny = { max_tokens: 16, messages: [{ role: 'user', content: 'a 20 mm cube' }] }
  sql(`update public.mimir_limits set install_daily_micros = ${spent() + 100}, install_in_flight = 3 where edition = 'slicerx'`)
  const asked = counted.length
  const exact = await call('/v1/messages', { body: tiny, headers: auth2 })
  assert.equal(exact.status, 200, await exact.clone().text())
  await exact.text()
  assert.equal(counted.length - asked, 1, 'the exact count was asked for')

  // Two stores at once for one install, room for one: each holds its transaction a second
  // after storing, so without the install lock both would read the day's bytes as empty.
  const inst = sql(`insert into public.mimir_installs (edition, token_hash, created_ip_hash) values ('slicerx', 'n7-' || gen_random_uuid(), 'x') returning id`).split('\n')[0]
  const calls = sql(`insert into public.mimir_calls (day, edition, install_id, ip_hash, reserved_micros, cost_micros, settled_at)
    select public.mimir_day(), 'slicerx', '${inst}', 'x', 0, 0, now() from generate_series(1, 2) returning id`).split('\n').slice(0, 2)
  sql(`update public.mimir_limits set install_store_daily_bytes = 30 where edition = 'slicerx'`)
  const store = (id, key) => new Promise((done, fail) => execFile('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-tA', '-c',
    `begin; select public.mimir_save_chat('${id}', true, '${key}', '0.2.0', 'claude-haiku-5-5', null, null, '{"pad": "xxxxxxxxxx"}'); select pg_sleep(1); commit;`],
  { encoding: 'utf8' }, (e, out) => (e ? fail(e) : done(out))))
  const stored = await Promise.all([store(calls[0], 'n7-a'), store(calls[1], 'n7-b')])
  assert.deepEqual(stored.map((o) => o.split('\n').find((l) => l === 't' || l === 'f')).sort(), ['f', 't'], 'one store fits, the other is refused')
  assert.ok(Number(sql(`select sum(stored_bytes) from public.mimir_calls where install_id = '${inst}'`)) <= 30, 'the stored bytes stay under the day\'s cap')
  assert.equal(sql(`select count(*) from public.mimir_sessions where install_id = '${inst}'`), '1')
  sql(`update public.mimir_limits set install_store_daily_bytes = 33554432 where edition = 'slicerx'`)
  console.log('mimir proxy integration: ok')
} finally {
  sql(RESET)
  mock.close()
}
