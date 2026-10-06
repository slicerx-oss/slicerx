// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Moonraker HTTP API fake: https://moonraker.readthedocs.io/en/latest/web_api/
import { createHash } from 'node:crypto'
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

/** The user login a `forceLogins` server accepts (`POST /access/login`). */
export const MOCK_MOONRAKER_LOGIN = { user: 'maker', password: 'mock-login-pass' }

/** What `POST /moonraker` on the control server changes. `variant` makes the fake a QIDI printer with a QIDI Box
 * or a Snapmaker U1 (its Klipper objects); `klippy` is Klipper's state (`shutdown` answers queries with a
 * `webhooks` message, `startup` answers them with 503); `expireTokens` ends every access token issued so far. */
export interface MoonrakerControl {
  variant?: 'qidi' | 'u1'
  klippy: 'ready' | 'shutdown' | 'startup'
  message: string
  /** Access tokens still valid, and refresh tokens. */
  tokens: Set<string>
  refresh: Set<string>
}

/** The Klipper objects the fake has, as `/printer/objects/list` names them. */
function objectNames(m: MockMachine, c: MoonrakerControl): string[] {
  const out = ['webhooks', 'configfile', 'toolhead', 'print_stats', 'virtual_sdcard', 'gcode_move', 'fan', 'exclude_object']
  m.fx.nozzles.forEach((_, i) => out.push(i === 0 ? 'extruder' : `extruder${i}`))
  if (m.fx.bed) out.push('heater_bed')
  if (m.fx.chamber) out.push('temperature_sensor chamber')
  if (c.variant === 'qidi') out.push('save_variables', 'box_stepper slot0', 'box_stepper slot1', 'box_stepper slot2', 'box_stepper slot3')
  if (c.variant === 'u1') out.push('print_task_config', 'filament_detect')
  return out
}

/** The objects only a QIDI printer or a U1 has: a QIDI Box with two spools in, the U1's four toolheads. */
function variantStatus(c: MoonrakerControl): Record<string, unknown> {
  if (c.variant === 'qidi') {
    return {
      save_variables: { variables: { box_count: 1, filament_slot0: 1, color_slot0: 2, filament_slot1: 3, color_slot1: 1 } },
      'box_stepper slot0': { runout_button: 0 },
      'box_stepper slot1': { runout_button: 0 },
      'box_stepper slot2': { runout_button: 1 },
      'box_stepper slot3': { runout_button: 1 },
    }
  }
  if (c.variant === 'u1') {
    return { print_task_config: { filament_exist: [true, true, false, true], filament_type: ['PLA', 'PETG', '', 'PLA'], filament_sub_type: ['SnapSpeed', 'NONE', '', 'Matte'], filament_color_rgba: ['FF0000FF', '00FF00FF', '', '000000FF'], filament_vendor: ['Snapmaker', 'Generic', '', 'Generic'] } }
  }
  return {}
}

export async function startMoonraker(m: MockMachine, opts: { apiKey?: string; forceLogins?: boolean } = {}) {
  let port = 0
  let issued = 0
  const control: MoonrakerControl = { klippy: 'ready', message: '', tokens: new Set(), refresh: new Set() }
  const unauthorized = { status: 401, json: { error: { code: 401, message: 'Unauthorized' } } }
  const handler: Handler = async (req) => {
    // Open to everyone, as in Moonraker: what sign-in the server wants, and the user login.
    if (req.path === '/access/info') return { json: { result: { default_source: 'moonraker', available_sources: ['moonraker'], login_required: Boolean(opts.forceLogins), trusted: !opts.apiKey && !opts.forceLogins } } }
    if (req.path === '/access/login' && req.method === 'POST') {
      const b = req.json() as { username?: string; password?: string }
      if (!opts.forceLogins || b.username !== MOCK_MOONRAKER_LOGIN.user || b.password !== MOCK_MOONRAKER_LOGIN.password) return unauthorized
      const token = `access-${++issued}`
      const refresh = `refresh-${issued}`
      control.tokens.add(token)
      control.refresh.add(refresh)
      m.log.push('login')
      return { json: { result: { username: b.username, token, refresh_token: refresh, action: 'user_logged_in', source: 'moonraker' } } }
    }
    if (req.path === '/access/refresh_jwt' && req.method === 'POST') {
      const b = req.json() as { refresh_token?: string }
      if (!b.refresh_token || !control.refresh.has(b.refresh_token)) return unauthorized
      const token = `access-${++issued}`
      control.tokens.add(token)
      m.log.push('refresh_jwt')
      return { json: { result: { username: MOCK_MOONRAKER_LOGIN.user, token, source: 'moonraker', action: 'user_jwt_refresh' } } }
    }
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
    const signedIn = bearer !== undefined && control.tokens.has(bearer)
    if ((opts.apiKey || opts.forceLogins) && !signedIn && req.headers['x-api-key'] !== (opts.apiKey ?? MOCK_FORCED_KEY)) return unauthorized
    const p = req.path
    if (p === '/server/info') return { json: { result: { klippy_state: control.klippy, moonraker_version: 'mock', ...(control.variant === 'qidi' ? { machine_name: 'X-Max 4' } : {}) } } }
    if (p === '/printer/info') return { json: { result: { state: control.klippy, state_message: control.message || 'Printer is ready', hostname: control.variant === 'u1' ? 'U1' : 'mock', software_version: 'v0.12.0-mock' } } }
    if (p === '/printer/objects/list') return { json: { result: { objects: objectNames(m, control) } } }
    if (p === '/server/files/config/officiall_filas_list.cfg' && control.variant === 'qidi') return { body: Buffer.from('[colordict]\n1 = FFFFFFFF\n2 = 0000FFFF\n\n[fila1]\nfilament = PLA Rapido\n[fila3]\nfilament = PETG Tough\n'), type: 'text/plain' }
    if (p === '/server/webcams/list') {
      m.log.push('webcams list')
      return { json: { result: { webcams: m.fx.cameraAvailable ? [{ name: 'disabled', enabled: false, service: 'mjpegstreamer', stream_url: '/nowhere/stream', snapshot_url: '/nowhere/snapshot' },
        { name: 'cam', snapshot_url: `http://127.0.0.1:${port}/webcam/snapshot`, stream_url: `http://127.0.0.1:${port}/webcam/stream`, flip_horizontal: true, rotation: 180 },
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
      if (m.state === 'offline' || control.klippy === 'startup') return { status: 503, json: { error: 'not ready' } }
      const status: Record<string, unknown> = { ...moonrakerStatus(m), ...variantStatus(control), webhooks: { state: control.klippy, state_message: control.message || 'Printer is ready' } }
      // The parts of Klipper's config the setup reads: one 0.4 mm nozzle per extruder.
      if (req.query.has('configfile')) status.configfile = { settings: { printer: { kinematics: 'corexy', max_velocity: 500, max_accel: 10000 }, ...Object.fromEntries(Array.from({ length: m.fx.nozzleCount }, (_, i) => [i === 0 ? 'extruder' : `extruder${i}`, { nozzle_diameter: 0.4 }])) } }
      if (req.query.has('toolhead')) status.toolhead = { position: [...m.position, 0], homed_axes: m.homed, axis_minimum: [...m.axisMin, 0], axis_maximum: [...m.axisMax, 0] }
      if (req.query.has('exclude_object') && m.job && (m.state === 'printing' || m.state === 'paused')) {
        status.exclude_object = { objects: m.objects.map((name, i) => ({ name, center: [40 + i * 60, 50], polygon: [[30 + i * 60, 40], [50 + i * 60, 40], [50 + i * 60, 60], [30 + i * 60, 60]] })), excluded_objects: [...m.excluded], current_object: null }
      }
      return { json: { result: { status } } }
    }
    if (p === '/server/files/upload' && req.method === 'POST') {
      const f = await readFilePart(req)
      // Moonraker checks a `checksum` field (SHA-256 hex) before it keeps the file.
      const sum = (await req.form()).get('checksum')
      if (sum !== undefined && sum !== null && sum !== createHash('sha256').update(f.data).digest('hex')) return { status: 422, json: { error: { code: 422, message: 'checksum mismatch' } } }
      m.log.push(`moonraker upload checksum ${sum ? 'sent' : 'none'}`)
      if (m.uploadDelayMs > 0) await new Promise((r) => setTimeout(r, m.uploadDelayMs))
      m.upload(f.name, f.data)
      return { status: 201, json: { item: { path: f.name, root: 'gcodes' }, action: 'create_file' } }
    }
    if (p === '/server/files/list') return { json: { result: [...m.files.values()].map((f) => ({ path: f.name, modified: f.modified, size: f.size, permissions: 'rw' })) } }
    if (p === '/server/history/list') return { json: { result: { count: m.history.length, jobs: m.history } } }
    if (p === '/server/files/metadata') {
      // QIDI's Moonraker on the Q2 and X-Max 4 answers 404 for every file.
      if (control.variant === 'qidi') throw new MockError(404, 'not in the metadata whitelist')
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
  return { server, port, control }
}
