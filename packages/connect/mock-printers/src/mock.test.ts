// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { X509Certificate } from 'node:crypto'
import { MOCK_API_KEY, MOCK_HA_TOKEN, startMocks, type RunningMocks } from './index.ts'
import { throwawayCert } from './tls.ts'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NONCE, REALM, startRtsp } from './rtsp.ts'

let plain: RunningMocks
let authed: RunningMocks

before(async () => {
  plain = await startMocks({ only: ['moonraker', 'prusalink', 'octoprint', 'duet', 'spoolman', 'home-assistant', 'elegoo'] })
  authed = await startMocks({ only: ['moonraker', 'prusalink', 'octoprint'], auth: true, state: 'idle' })
})
after(async () => {
  await plain.stop()
  await authed.stop()
})

const url = (m: RunningMocks, name: string, path: string) => `http://127.0.0.1:${m.ports[name]}${path}`
const json = async (r: Response) => (await r.json()) as Record<string, any>

test('fixture states come through each protocol', async () => {
  // Bay 4 (Voron on Klipper) finished, Bay 3 (MK4S) paused with a message.
  const moon = await json(await fetch(url(plain, 'moonraker', '/printer/objects/query?print_stats')))
  assert.equal(moon.result.status.print_stats.state, 'complete')
  const prusa = await json(await fetch(url(plain, 'prusalink', '/api/v1/status')))
  assert.equal(prusa.printer.state, 'ATTENTION')
  const duet = await json(await fetch(url(plain, 'duet', '/rr_model?flags=d99vn')))
  assert.equal(duet.result.state.status, 'idle')
})

test('auth is enforced when asked for', async () => {
  for (const [name, path] of [['moonraker', '/server/info'], ['prusalink', '/api/v1/info'], ['octoprint', '/api/version']] as const) {
    assert.ok([401, 403].includes((await fetch(url(authed, name, path))).status), name)
    const ok = await fetch(url(authed, name, path), { headers: { 'x-api-key': MOCK_API_KEY } })
    assert.equal(ok.status, 200, name)
  }
})

test('a request that changes state is logged and rejected when the state is wrong', async () => {
  const bad = await fetch(url(authed, 'moonraker', '/printer/print/pause'), { method: 'POST', headers: { 'x-api-key': MOCK_API_KEY } })
  assert.equal(bad.status, 409)
  const state = await json(await fetch(`http://127.0.0.1:${authed.control}/state`))
  assert.equal(state.moonraker.state, 'idle')
})

test('spoolman and home assistant fakes', async () => {
  const spools = (await (await fetch(url(plain, 'spoolman', '/api/v1/spool'))).json()) as unknown[]
  assert.equal(spools.length, 9)
  assert.equal((await fetch(url(plain, 'home-assistant', '/api/states'))).status, 401)
  const ha = (await (await fetch(url(plain, 'home-assistant', '/api/states'), { headers: { authorization: `Bearer ${MOCK_HA_TOKEN}` } })).json()) as unknown[]
  assert.equal(ha.length, 7)
})

test('elegoo mock refuses a bad websocket path', async () => {
  const r = await fetch(url(plain, 'elegoo', '/nope'))
  assert.equal(r.status, 404)
})

test('the TLS printers present an X.509 v3 certificate, as real printers do', () => {
  // A v1 certificate has no extensions, so it cannot name the address; rustls refuses v1 outright.
  const cert = new X509Certificate(throwawayCert().cert)
  assert.match(cert.subjectAltName ?? '', /IP Address:127\.0\.0\.1/)
  assert.equal(cert.ca, false)
})

// The camera checks a digest login as live555 does: every value quoted, uri the request line's,
// and the response over the right code. A stray unquoted algorithm before or after the response, a
// wrong code, or a path in place of the full URI gets 401; the header that worked on the H2D gets 200.
test('the RTSP camera checks a digest login as live555 does', async () => {
  const cam = await startRtsp({ login: { user: 'bblp', pass: '12345678', scheme: 'digest' }, path: '/streaming/live/1' })
  const uri = `rtsp://127.0.0.1:${cam.port}/streaming/live/1`
  const md5 = (x: string) => createHash('md5').update(x).digest('hex')
  const response = (code: string) => md5(`${md5(`bblp:${REALM}:${code}`)}:${NONCE}:${md5(`DESCRIBE:${uri}`)}`)
  const describe = (auth: string) =>
    new Promise<string>((resolve) => {
      const sock = connect(cam.port, '127.0.0.1', () => sock.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: 3\r\nAccept: application/sdp\r\nAuthorization: ${auth}\r\n\r\n`))
      sock.once('data', (d) => {
        resolve(d.toString('latin1').split('\r\n')[0] ?? '')
        sock.destroy()
      })
    })
  const head = `Digest username="bblp", realm="${REALM}", nonce="${NONCE}", uri="${uri}"`
  try {
    assert.equal(await describe(`${head}, response="${response('12345678')}"`), 'RTSP/1.0 200 OK')
    assert.equal(await describe(`${head}, algorithm=MD5, response="${response('12345678')}"`), 'RTSP/1.0 401 Unauthorized')
    assert.equal(await describe(`${head}, response="${response('12345678')}", algorithm=MD5`), 'RTSP/1.0 401 Unauthorized')
    assert.equal(await describe(`${head}, response="${response('87654321')}"`), 'RTSP/1.0 401 Unauthorized')
    assert.equal(await describe(`${head.replace(uri, '/streaming/live/1')}, response="${response('12345678')}"`), 'RTSP/1.0 401 Unauthorized')
  } finally {
    cam.close()
  }
})

// Developer Mode as the report's `fun` flags carry it: bit 0x20000000 set while it is off.
test('the Bambu fake reports Developer Mode in its fun flags', async () => {
  const { reportFor } = await import('./bambu.ts')
  const { MockMachine } = await import('./machine.ts')
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/demo-fleet.json', import.meta.url)), 'utf8'))
  const m = new MockMachine(fixture, 'bay-1')
  const fun = (developerMode?: boolean) => (reportFor(m, { skipped: [], printError: 0, ...(developerMode === undefined ? {} : { developerMode }) }).print as { fun?: string }).fun
  const signed = (f: string | undefined) => (BigInt(`0x${f}`) & 0x20000000n) !== 0n
  assert.equal(signed(fun(false)), true)
  assert.equal(signed(fun(true)), false)
  assert.equal(fun(), undefined)
})
