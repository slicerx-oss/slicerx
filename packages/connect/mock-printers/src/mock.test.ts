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

test('the Bambu camera sends a JPEG file in place of its picture when asked', async () => {
  const { MOCK_ACCESS_CODE } = await import('./bambu.ts')
  const { connect: tlsConnect } = await import('node:tls')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const m = await startMocks({ only: ['bambu'] })
  try {
    const file = join(mkdtempSync(join(tmpdir(), 'mock-frame-')), 'frame.jpg')
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a photo'), Buffer.from([0xff, 0xd9])])
    writeFileSync(file, photo)
    const set = await fetch(`http://127.0.0.1:${m.control}/bambu`, { method: 'POST', body: JSON.stringify({ cameraFrameFile: file }) })
    assert.equal(set.status, 200)
    const login = Buffer.alloc(80)
    login.write('bblp', 16)
    login.write(MOCK_ACCESS_CODE, 48)
    const got = await new Promise<Buffer>((resolve, reject) => {
      const sock = tlsConnect({ port: m.ports['bambu-camera']!, host: '127.0.0.1', rejectUnauthorized: false })
      let buf = Buffer.alloc(0)
      sock.on('error', reject)
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        if (buf.length >= 16 && buf.length >= 16 + buf.readUInt32LE(0)) {
          sock.destroy()
          resolve(buf.subarray(16, 16 + buf.readUInt32LE(0)))
        }
      })
      sock.write(login)
    })
    assert.deepEqual(got, photo)
  } finally {
    await m.stop()
  }
})

// The simulated printers: each brand's status, upload, start, pause, resume and cancel, its faults and their
// clearing, and the camera frame `POST /camera` picks.

const post = async (m: RunningMocks, path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${m.control}${path}`, { method: 'POST', body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> }
}
const mockState = async (m: RunningMocks, name: string) => (await json(await fetch(`http://127.0.0.1:${m.control}/state`)))[name] as Record<string, any>
/** Resolves with the error a fetch fails with, or undefined when it got an answer. */
const failure = async (u: string, init: RequestInit = {}) => {
  try {
    await (await fetch(u, init)).arrayBuffer()
    return undefined
  } catch (e) {
    return e as Error
  }
}
/** The first `parts` JPEGs of an MJPEG stream. */
async function mjpegParts(u: string, parts: number): Promise<Buffer[]> {
  const ac = new AbortController()
  const r = await fetch(u, { signal: ac.signal })
  const reader = r.body!.getReader()
  let buf = Buffer.alloc(0)
  const out: Buffer[] = []
  try {
    while (out.length < parts) {
      const { value, done } = await reader.read()
      if (done) break
      buf = Buffer.concat([buf, Buffer.from(value)])
      for (;;) {
        const head = buf.indexOf('\r\n\r\n')
        if (head < 0) break
        const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString('latin1'))?.[1] ?? -1)
        if (len < 0 || buf.length < head + 4 + len) break
        out.push(Buffer.from(buf.subarray(head + 4, head + 4 + len)))
        buf = buf.subarray(head + 4 + len + 2)
      }
    }
  } finally {
    ac.abort()
  }
  return out
}

test('the job tick moves progress, layer and time left, and finishes the job', async () => {
  const { MockMachine } = await import('./machine.ts')
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/demo-fleet.json', import.meta.url)), 'utf8'))
  const m = new MockMachine(fixture, 'bay-2')
  m.upload('a.gcode', Buffer.from('G28'))
  m.start('a.gcode')
  m.tick(900)
  assert.deepEqual({ ...m.job }, { name: 'a.gcode', progress: 0.25, layer: 25, layerCount: 100, timeLeftS: 2700 })
  assert.equal(m.printedS, 900)
  m.pause()
  m.tick(900)
  assert.equal(m.job?.timeLeftS, 2700, 'a paused job stands still')
  m.resume()
  m.tick(5000)
  assert.equal(m.state, 'finished')
  assert.deepEqual([m.job?.progress, m.job?.layer, m.job?.timeLeftS], [1, 100, 0])
  assert.ok(m.log.includes('finished'))
})

test('the mocks keep still unless asked to tick', async () => {
  const mocks = await startMocks({ only: ['prusalink'] })
  try {
    const before = await mockState(mocks, 'prusalink')
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(await mockState(mocks, 'prusalink'), before)
    // The fixture's Bay 3 is paused, so a tick changes nothing until it prints.
    assert.equal((await post(mocks, '/tick', { mock: 'prusalink', seconds: 60 })).body.job.timeLeftS, 6300)
  } finally {
    await mocks.stop()
  }
})

test('PrusaLink: lifecycle, telemetry, the spec 409s, faults and the camera', async () => {
  const { HAND_FRAME } = await import('./frames.ts')
  const { JPEG } = await import('./machine.ts')
  const mocks = await startMocks({ only: ['prusalink'], state: 'idle' })
  const u = (p: string) => url(mocks, 'prusalink', p)
  try {
    const status = async () => (await json(await fetch(u('/api/v1/status')))).printer as Record<string, any>
    assert.equal((await status()).state, 'IDLE')
    assert.equal((await status()).axis_x, 100, 'axis_x while the head is still')
    assert.equal((await fetch(u('/api/v1/files/usb/a.gcode'), { method: 'PUT', body: 'G28\n' })).status, 201)
    assert.equal((await fetch(u('/api/v1/files/usb/a.gcode'), { method: 'POST' })).status, 204)
    let s = await status()
    assert.equal(s.state, 'PRINTING')
    assert.equal(s.axis_x, undefined, 'no axis_x while moving')
    assert.deepEqual([s.flow, s.speed, typeof s.fan_print, typeof s.fan_hotend], [100, 100, 'number', 'number'])
    await post(mocks, '/tick', { mock: 'prusalink', seconds: 360 })
    const job = await json(await fetch(u('/api/v1/job')))
    assert.deepEqual([Math.round(job.progress), job.time_remaining, job.time_printing], [10, 3240, 360])
    assert.deepEqual(job.file.meta, { layer_height: 0.2, max_layer_z: 20, estimated_print_time: 3600, layer_info_present: true })
    assert.equal((await status()).axis_z, 2)
    // Pause and resume in the wrong state get the spec's 409; another job id its 404.
    assert.equal((await fetch(u('/api/v1/job/1/resume'), { method: 'PUT' })).status, 409)
    assert.equal((await fetch(u('/api/v1/job/7/pause'), { method: 'PUT' })).status, 404)
    assert.equal((await fetch(u('/api/v1/job/1/pause'), { method: 'PUT' })).status, 204)
    assert.equal((await fetch(u('/api/v1/job/1/pause'), { method: 'PUT' })).status, 409)
    assert.equal((await status()).state, 'PAUSED')
    assert.equal((await fetch(u('/api/v1/job/1/resume'), { method: 'PUT' })).status, 204)
    // A runout: ATTENTION with the message; cleared, the print waits paused for a resume.
    assert.deepEqual((await post(mocks, '/fault', { mock: 'prusalink', kind: 'runout' })).body, { state: 'paused', faults: ['runout'] })
    s = await status()
    assert.equal(s.state, 'ATTENTION')
    assert.deepEqual(s.status_printer, { ok: false, message: 'Filament runout' })
    await post(mocks, '/fault', { mock: 'prusalink', kind: 'clear' })
    s = await status()
    assert.deepEqual([s.state, s.status_printer], ['PAUSED', undefined])
    assert.equal((await fetch(u('/api/v1/job/1/resume'), { method: 'PUT' })).status, 204)
    // A door is not a Prusa concept: logged, nothing else.
    await post(mocks, '/fault', { mock: 'prusalink', kind: 'door' })
    assert.equal((await status()).state, 'PRINTING')
    // Offline: one 503, then connections are refused until cleared.
    await post(mocks, '/fault', { mock: 'prusalink', kind: 'offline' })
    assert.equal((await fetch(u('/api/v1/status'))).status, 503)
    assert.ok(await failure(u('/api/v1/status')), 'refused after the 503')
    await post(mocks, '/fault', { mock: 'prusalink', kind: 'clear' })
    assert.equal((await status()).state, 'PRINTING')
    // Cancel.
    assert.equal((await fetch(u('/api/v1/job/1'), { method: 'DELETE' })).status, 204)
    assert.equal((await fetch(u('/api/v1/job'))).status, 204)
    const log = (await mockState(mocks, 'prusalink')).log as string[]
    for (const line of ['fault runout', 'fault clear', 'fault door', 'fault offline', 'cancel']) assert.ok(log.includes(line), line)
    // The camera: the placeholder, then the hand.
    const snap = async () => Buffer.from(await (await fetch(u('/api/v1/cameras/cam1/snap'))).arrayBuffer())
    assert.deepEqual(await snap(), JPEG)
    assert.equal((await post(mocks, '/camera', { mock: 'prusalink', frame: 'hand' })).status, 200)
    assert.deepEqual(await snap(), HAND_FRAME)
    assert.equal((await mockState(mocks, 'prusalink')).camera, 'hand')
    assert.ok(((await mockState(mocks, 'prusalink')).log as string[]).includes('camera hand'))
  } finally {
    await mocks.stop()
  }
})

test('PrusaLink: a second upload while one is landing finds the storage busy', async () => {
  const mocks = await startMocks({ only: ['prusalink'], state: 'idle' })
  try {
    await post(mocks, '/slow', { mock: 'prusalink', uploadMs: 300 })
    const put = (n: string) => fetch(url(mocks, 'prusalink', `/api/v1/files/usb/${n}`), { method: 'PUT', body: 'G28\n' }).then((r) => r.status)
    const first = put('a.gcode')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await put('b.gcode'), 409)
    assert.equal(await first, 201)
  } finally {
    await mocks.stop()
  }
})

test('Elegoo: SDCP lifecycle, pushed status, faults and a continuous MJPEG stream', async () => {
  const { HAND_FRAME } = await import('./frames.ts')
  const mocks = await startMocks({ only: ['elegoo'], state: 'idle' })
  const port = mocks.ports.elegoo!
  const statuses: Record<string, any>[] = []
  const replies: Record<string, any>[] = []
  const open = () => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/websocket`)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('refused'))
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as Record<string, any>
      if (msg.Status) statuses.push(msg.Status)
      else if (msg.Data?.Cmd !== undefined) replies.push(msg.Data)
    }
  })
  const until = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(ok(), what)
  }
  const last = () => statuses.at(-1)!
  let ws = await open()
  let rid = 0
  const cmd = async (c: number, data: Record<string, unknown> = {}) => {
    const id = String(++rid)
    ws.send(JSON.stringify({ Id: '', Data: { Cmd: c, Data: data, RequestID: id, MainboardID: '', TimeStamp: Date.now(), From: 0 } }))
    await until(`answer to ${c}`, () => replies.some((r) => r.RequestID === id))
    return replies.find((r) => r.RequestID === id)!.Data as Record<string, any>
  }
  try {
    // Cmd 0 is answered with a status report alone.
    ws.send(JSON.stringify({ Id: '', Data: { Cmd: 0, Data: {}, RequestID: '0', MainboardID: '', TimeStamp: Date.now(), From: 0 } }))
    await until('a status', () => statuses.length > 0)
    assert.deepEqual(last().CurrentStatus, [0])
    // Upload in one part with its MD5.
    const data = Buffer.from('G28\nG1 X10\n')
    const form = new FormData()
    form.set('Check', '1')
    form.set('S-File-MD5', createHash('md5').update(data).digest('hex'))
    form.set('Offset', '0')
    form.set('Uuid', 'u1')
    form.set('TotalSize', String(data.length))
    form.set('File', new Blob([data]), 'a.gcode')
    assert.equal((await fetch(`http://127.0.0.1:${port}/uploadFile/upload`, { method: 'POST', body: form })).status, 200)
    // Each change pushes a status without a refresh asked for.
    assert.equal((await cmd(128, { Filename: '/local/a.gcode', StartLayer: 0 })).Ack, 0)
    await until('printing pushed', () => last().PrintInfo.Status === 13)
    await post(mocks, '/tick', { mock: 'elegoo', seconds: 1800 })
    await until('progress pushed', () => last().PrintInfo.Progress === 50 && last().PrintInfo.CurrentLayer === 50)
    // While printing, a status a second.
    const n = statuses.length
    await until('the 1 s tick', () => statuses.length > n)
    assert.equal((await cmd(129)).Ack, 0)
    await until('paused pushed', () => last().PrintInfo.Status === 10)
    assert.equal((await cmd(129)).Ack, 1, 'pause while paused is refused')
    assert.equal((await cmd(131)).Ack, 0)
    await until('resumed pushed', () => last().PrintInfo.Status === 13)
    // A runout pauses as a pause command does (SDCP V3.0.0 has no runout code); the door is only logged.
    await post(mocks, '/fault', { mock: 'elegoo', kind: 'runout' })
    await until('runout pushed', () => last().PrintInfo.Status === 10 && last().CurrentStatus[0] === 1)
    await post(mocks, '/fault', { mock: 'elegoo', kind: 'door' })
    await post(mocks, '/fault', { mock: 'elegoo', kind: 'clear' })
    assert.equal((await mockState(mocks, 'elegoo')).state, 'paused')
    assert.equal((await cmd(131)).Ack, 0)
    // Offline drops the WebSocket and refuses a reconnect until cleared.
    const closed = new Promise<void>((r) => { ws.onclose = () => r() })
    await post(mocks, '/fault', { mock: 'elegoo', kind: 'offline' })
    await closed
    await assert.rejects(open())
    await post(mocks, '/fault', { mock: 'elegoo', kind: 'clear' })
    ws = await open()
    assert.equal((await cmd(130)).Ack, 0)
    await until('stopped pushed', () => last().CurrentStatus[0] === 0)
    // Cmd 386 names the stream, which keeps sending the chosen frame.
    const url386 = String((await cmd(386, { Enable: 1 })).VideoUrl)
    await post(mocks, '/camera', { mock: 'elegoo', frame: 'hand' })
    const parts = await mjpegParts(url386, 5)
    assert.equal(parts.length, 5)
    for (const p of parts) assert.deepEqual(p, HAND_FRAME)
    const log = (await mockState(mocks, 'elegoo')).log as string[]
    for (const line of ['fault runout', 'fault door', 'fault offline', 'fault clear', 'camera hand']) assert.ok(log.includes(line), line)
  } finally {
    ws.close()
    await mocks.stop()
  }
})

test('Snapmaker 2.0: lifecycle, the runout and door flags, offline hangs, no camera', async () => {
  const mocks = await startMocks({ only: ['snapmaker-luban'], state: 'idle' })
  const u = (p: string) => url(mocks, 'snapmaker-luban', p)
  try {
    const { token } = await json(await fetch(u('/api/v1/connect'), { method: 'POST' }))
    const status = async () => json(await fetch(u(`/api/v1/status?token=${token}`)))
    assert.equal((await fetch(u(`/api/v1/status?token=${token}`))).status, 204)
    assert.equal((await fetch(u(`/api/v1/status?token=${token}`))).status, 204)
    assert.equal((await status()).status, 'IDLE')
    const form = new FormData()
    form.set('token', token)
    form.set('type', '3DP')
    form.set('file', new Blob(['G28\n']), 'a.gcode')
    assert.equal((await fetch(u('/api/v1/prepare_print'), { method: 'POST', body: form })).status, 200)
    const act = (p: string) => fetch(u(p), { method: 'POST', body: new URLSearchParams({ token }) }).then((r) => r.status)
    assert.equal(await act('/api/v1/start_print'), 200)
    assert.equal((await status()).status, 'RUNNING')
    assert.equal(await act('/api/v1/pause_print'), 200)
    assert.equal((await status()).status, 'PAUSED')
    assert.equal(await act('/api/v1/resume_print'), 200)
    // The faults are the status flags; a runout also pauses.
    await post(mocks, '/fault', { mock: 'snapmaker-luban', kind: 'runout' })
    let s = await status()
    assert.deepEqual([s.status, s.isFilamentOut, s.isEnclosureDoorOpen], ['PAUSED', true, false])
    await post(mocks, '/fault', { mock: 'snapmaker-luban', kind: 'door' })
    assert.equal((await status()).isEnclosureDoorOpen, true)
    await post(mocks, '/fault', { mock: 'snapmaker-luban', kind: 'clear' })
    s = await status()
    assert.deepEqual([s.status, s.isFilamentOut, s.isEnclosureDoorOpen], ['PAUSED', false, false])
    assert.equal(await act('/api/v1/resume_print'), 200)
    // Offline: no answer, until the client gives up.
    await post(mocks, '/fault', { mock: 'snapmaker-luban', kind: 'offline' })
    const e = await failure(u(`/api/v1/status?token=${token}`), { signal: AbortSignal.timeout(300) })
    assert.equal(e?.name, 'TimeoutError')
    await post(mocks, '/fault', { mock: 'snapmaker-luban', kind: 'clear' })
    assert.equal((await status()).status, 'RUNNING')
    assert.equal(await act('/api/v1/stop_print'), 200)
    assert.equal((await status()).status, 'IDLE')
    // The 2.0 machines have no camera.
    assert.equal((await post(mocks, '/camera', { mock: 'snapmaker-luban', frame: 'hand' })).status, 400)
  } finally {
    await mocks.stop()
  }
})

test('Snapmaker U1: Moonraker with the U1 identity, a webcam showing the chosen frame, and faults', async () => {
  const { HAND_FRAME } = await import('./frames.ts')
  const { JPEG } = await import('./machine.ts')
  const mocks = await startMocks({ only: ['snapmaker-u1'], state: 'idle' })
  const u = (p: string) => url(mocks, 'snapmaker-u1', p)
  try {
    assert.equal((await json(await fetch(u('/printer/info')))).result.hostname, 'U1')
    assert.ok((await json(await fetch(u('/printer/objects/list')))).result.objects.includes('print_task_config'))
    const cams = (await json(await fetch(u('/server/webcams/list')))).result.webcams as Record<string, any>[]
    assert.equal(cams.length, 1)
    const snap = async () => Buffer.from(await (await fetch(cams[0]!.snapshot_url)).arrayBuffer())
    assert.deepEqual(await snap(), JPEG)
    await post(mocks, '/camera', { mock: 'snapmaker-u1', frame: 'hand' })
    assert.deepEqual(await snap(), HAND_FRAME)
    assert.deepEqual((await mjpegParts(cams[0]!.stream_url, 2))[1], HAND_FRAME)
    // Lifecycle through Moonraker.
    const form = new FormData()
    form.set('file', new Blob(['G28\n']), 'a.gcode')
    assert.equal((await fetch(u('/server/files/upload'), { method: 'POST', body: form })).status, 201)
    const q = async () => (await json(await fetch(u('/printer/objects/query?print_stats&print_task_config')))).result.status as Record<string, any>
    for (const [p, want] of [['/printer/print/start?filename=a.gcode', 'printing'], ['/printer/print/pause', 'paused'], ['/printer/print/resume', 'printing']] as const) {
      assert.equal((await fetch(u(p), { method: 'POST' })).status, 200, p)
      assert.equal((await q()).print_stats.state, want, p)
    }
    // A runout pauses and empties the first toolhead; the door is only logged.
    await post(mocks, '/fault', { mock: 'snapmaker-u1', kind: 'runout' })
    let st = await q()
    assert.deepEqual([st.print_stats.state, st.print_task_config.filament_exist[0]], ['paused', false])
    await post(mocks, '/fault', { mock: 'snapmaker-u1', kind: 'door' })
    await post(mocks, '/fault', { mock: 'snapmaker-u1', kind: 'clear' })
    st = await q()
    assert.deepEqual([st.print_stats.state, st.print_task_config.filament_exist[0]], ['paused', true])
    // Offline refuses connections until cleared.
    await post(mocks, '/fault', { mock: 'snapmaker-u1', kind: 'offline' })
    assert.ok(await failure(u('/printer/info')))
    await post(mocks, '/fault', { mock: 'snapmaker-u1', kind: 'clear' })
    assert.equal((await q()).print_stats.state, 'paused')
    assert.equal((await fetch(u('/printer/print/cancel'), { method: 'POST' })).status, 200)
    assert.equal((await q()).print_stats.state, 'standby')
    const log = (await mockState(mocks, 'snapmaker-u1')).log as string[]
    for (const line of ['fault runout', 'fault door', 'fault offline', 'fault clear', 'camera hand', 'cancel']) assert.ok(log.includes(line), line)
  } finally {
    await mocks.stop()
  }
})

test('Bambu: the camera follows POST /camera, and faults are not modeled', async () => {
  const { HAND_FRAME } = await import('./frames.ts')
  const { MOCK_ACCESS_CODE } = await import('./bambu.ts')
  const { connect: tlsConnect } = await import('node:tls')
  const mocks = await startMocks({ only: ['bambu'] })
  const one = () => new Promise<Buffer>((resolve, reject) => {
    const login = Buffer.alloc(80)
    login.write('bblp', 16)
    login.write(MOCK_ACCESS_CODE, 48)
    const sock = tlsConnect({ port: mocks.ports['bambu-camera']!, host: '127.0.0.1', rejectUnauthorized: false })
    let buf = Buffer.alloc(0)
    sock.on('error', reject)
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (buf.length >= 16 && buf.length >= 16 + buf.readUInt32LE(0)) {
        sock.destroy()
        resolve(buf.subarray(16, 16 + buf.readUInt32LE(0)))
      }
    })
    sock.write(login)
  })
  try {
    assert.equal((await post(mocks, '/camera', { mock: 'bambu', frame: 'hand' })).status, 200)
    assert.deepEqual(await one(), HAND_FRAME)
    // The older control names still work and land on the same frame.
    await post(mocks, '/bambu', { cameraFrame: null })
    assert.equal((await mockState(mocks, 'bambu')).camera, 'placeholder')
    await post(mocks, '/bambu', { cameraFrame: 'hand' })
    assert.deepEqual(await one(), HAND_FRAME)
    assert.equal((await post(mocks, '/fault', { mock: 'bambu', kind: 'runout' })).status, 400)
  } finally {
    await mocks.stop()
  }
})
