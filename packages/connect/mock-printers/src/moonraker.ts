// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Moonraker HTTP API fake: https://moonraker.readthedocs.io/en/latest/web_api/
import { JPEG, MockError, type MockMachine } from './machine.ts'
import { listen, mjpeg, readFilePart, type Handler } from './http-util.ts'

export function moonrakerStatus(m: MockMachine): Record<string, unknown> {
  const stats: Record<string, string> = { idle: 'standby', printing: 'printing', paused: 'paused', finished: 'complete', error: 'error', preparing: 'printing', offline: 'standby' }
  const st: Record<string, unknown> = {
    print_stats: {
      state: stats[m.state] ?? 'standby',
      filename: m.job?.name ?? '',
      print_duration: m.job ? m.job.progress * 3600 : 0,
      message: m.message ?? '',
      info: { current_layer: m.job?.layer ?? null, total_layer: m.job?.layerCount ?? null },
    },
    virtual_sdcard: { progress: m.job?.progress ?? 0 },
  }
  m.fx.nozzles.forEach((n, i) => { st[i === 0 ? 'extruder' : `extruder${i}`] = { temperature: n.current, target: n.target } })
  if (m.fx.bed) st.heater_bed = { temperature: m.fx.bed.current, target: m.fx.bed.target }
  if (m.fx.chamber) st['temperature_sensor chamber'] = { temperature: m.fx.chamber.current }
  return st
}

/** The API key a `forceLogins` server accepts when no other key is set. */
export const MOCK_FORCED_KEY = 'mock-forced-key'

export async function startMoonraker(m: MockMachine, opts: { apiKey?: string; forceLogins?: boolean } = {}) {
  let port = 0
  const handler: Handler = async (req) => {
    // Open to everyone, as in Moonraker: what sign-in the server wants.
    if (req.path === '/access/info') return { json: { result: { default_source: 'moonraker', available_sources: ['moonraker'], login_required: Boolean(opts.forceLogins), trusted: !opts.apiKey && !opts.forceLogins } } }
    if ((opts.apiKey || opts.forceLogins) && req.headers['x-api-key'] !== (opts.apiKey ?? MOCK_FORCED_KEY)) return { status: 401, json: { error: { code: 401, message: 'Unauthorized' } } }
    const p = req.path
    if (p === '/server/info') return { json: { result: { klippy_state: 'ready', moonraker_version: 'mock' } } }
    if (p === '/printer/info') return { json: { result: { state: 'ready', hostname: 'mock', software_version: 'v0.12.0-mock' } } }
    if (p === '/server/webcams/list') {
      return { json: { result: { webcams: m.fx.cameraAvailable ? [{ name: 'cam', snapshot_url: `http://127.0.0.1:${port}/webcam/snapshot`, stream_url: `http://127.0.0.1:${port}/webcam/stream` },
        { name: 'crowsnest-webrtc', service: 'webrtc-camerastreamer', stream_url: `http://127.0.0.1:${port}/webcam/webrtc` },
        { name: 'mediamtx', service: 'webrtc-mediamtx', stream_url: `http://127.0.0.1:${port}/webcam/whep` }] : [] } } }
    }
    if (p === '/webcam/snapshot') return { body: JPEG, type: 'image/jpeg' }
    if (p === '/webcam/stream') return { stream: mjpeg(JPEG) }
    // WebRTC signaling. Each route checks the request format its real counterpart expects and answers
    // with a marker so a test can tell which one it reached.
    const answer = (route: string) => `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=mock\r\nt=0 0\r\na=sx-mock-answer:${route}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n`
    const isOffer = (sdp: unknown) => typeof sdp === 'string' && sdp.startsWith('v=0')
    if (p === '/webcam/webrtc' && req.method === 'POST') {
      const b = req.json() as { type?: string; sdp?: string }
      if (b.type !== 'offer' || !isOffer(b.sdp)) throw new MockError(400, 'bad offer')
      return { json: { type: 'answer', sdp: answer('camerastreamer') } }
    }
    if (p === '/webcam/whep' && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/sdp' || !isOffer(req.body.toString('utf8'))) throw new MockError(400, 'bad offer')
      return { status: 201, body: answer('whep'), type: 'application/sdp' }
    }
    if (p === '/call/webrtc_local' && req.method === 'POST') {
      // The Creality K2 flow: base64 of {"type":"offer","sdp"} as plain/text.
      const b = JSON.parse(Buffer.from(req.body.toString('utf8'), 'base64').toString('utf8')) as { type?: string; sdp?: string }
      if (req.headers['content-type'] !== 'plain/text' || b.type !== 'offer' || !isOffer(b.sdp)) throw new MockError(400, 'bad offer')
      return { body: Buffer.from(JSON.stringify({ type: 'answer', sdp: answer('creality') })).toString('base64'), type: 'text/plain' }
    }
    if (p === '/printer/objects/query') {
      if (m.state === 'offline') return { status: 503, json: { error: 'not ready' } }
      const status = moonrakerStatus(m)
      // The parts of Klipper's config the setup reads: one 0.4 mm nozzle per extruder.
      if (req.query.has('configfile')) status.configfile = { settings: Object.fromEntries(Array.from({ length: m.fx.nozzleCount }, (_, i) => [i === 0 ? 'extruder' : `extruder${i}`, { nozzle_diameter: 0.4 }])) }
      if (req.query.has('toolhead')) status.toolhead = { position: [...m.position, 0], homed_axes: m.homed, axis_minimum: [...m.axisMin, 0], axis_maximum: [...m.axisMax, 0] }
      if (req.query.has('exclude_object') && m.job && (m.state === 'printing' || m.state === 'paused')) {
        status.exclude_object = { objects: m.objects.map((name, i) => ({ name, center: [40 + i * 60, 50], polygon: [[30 + i * 60, 40], [50 + i * 60, 40], [50 + i * 60, 60], [30 + i * 60, 60]] })), excluded_objects: [...m.excluded], current_object: null }
      }
      return { json: { result: { status } } }
    }
    if (p === '/server/files/upload' && req.method === 'POST') {
      const f = await readFilePart(req)
      if (m.uploadDelayMs > 0) await new Promise((r) => setTimeout(r, m.uploadDelayMs))
      m.upload(f.name, f.data)
      return { status: 201, json: { item: { path: f.name, root: 'gcodes' }, action: 'create_file' } }
    }
    if (p === '/server/files/list') return { json: { result: [...m.files.values()].map((f) => ({ path: f.name, modified: f.modified, size: f.size, permissions: 'rw' })) } }
    if (p === '/server/history/list') return { json: { result: { count: m.history.length, jobs: m.history } } }
    if (p === '/server/files/metadata') {
      const f = m.files.get(req.query.get('filename') ?? '')
      if (!f) throw new MockError(404, 'no such file')
      return { json: { result: { filename: f.name, size: f.size, modified: f.modified } } }
    }
    if (p === '/printer/print/start') { m.start(req.query.get('filename') ?? ''); return { json: { result: 'ok' } } }
    if (p === '/printer/print/pause') { m.pause(); return { json: { result: 'ok' } } }
    if (p === '/printer/print/resume') { m.resume(); return { json: { result: 'ok' } } }
    if (p === '/printer/print/cancel') { m.cancel(); return { json: { result: 'ok' } } }
    if (p === '/printer/gcode/script') { m.gcode(req.query.get('script') ?? ''); return { json: { result: 'ok' } } }
    throw new MockError(404, p)
  }
  const { server, port: bound } = await listen(handler)
  port = bound
  return { server, port }
}
