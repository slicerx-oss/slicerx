// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/mock-printers. See README.md for the public API.
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { DemoFleet, PrinterState } from '@slicerx/contracts'
import { startOnvif } from './onvif.ts'
import { startRtsp } from './rtsp.ts'
import { startBambu, MOCK_ACCESS_CODE, MOCK_SERIAL, type BambuExtra } from './bambu.ts'
import { MOCK_CLOUD_TOKEN, startCloud } from './cloud.ts'
import { startCreality } from './creality.ts'
import { startDuet } from './duet.ts'
import { startElegoo } from './elegoo.ts'
import { listen } from './http-util.ts'
import { MockMachine } from './machine.ts'
import { MOCK_MOONRAKER_LOGIN, startMoonraker, type MoonrakerControl } from './moonraker.ts'
import { startOctoPrint } from './octoprint.ts'
import { startSnapmakerLuban } from './snapmaker.ts'
import { startPrusaLink } from './prusalink.ts'
import { MOCK_HA_TOKEN, startHomeAssistant, startSpoolman } from './services.ts'

export { MOCK_ACCESS_CODE, MOCK_SERIAL, MOCK_HA_TOKEN, MOCK_CLOUD_TOKEN, MOCK_MOONRAKER_LOGIN }

export const MOCK_API_KEY = 'mock-api-key'
export const MOCK_DUET_PASSWORD = 'mock-reprap'
export const MOCK_DIGEST = { user: 'maker', password: 'mock-digest-pass' }

/** Login of the generic RTSP camera mock (`rtsp://HOST:PORT/live`, Basic). */
export const MOCK_RTSP_CAMERA = { user: 'cam', password: 'cam-pass', path: '/live' }

export type MockName = 'moonraker' | 'prusalink' | 'octoprint' | 'duet' | 'elegoo' | 'creality' | 'snapmaker-luban' | 'cloud' | 'bambu' | 'spoolman' | 'home-assistant' | 'rtsp-camera'
export const ALL_MOCKS: MockName[] = ['moonraker', 'prusalink', 'octoprint', 'duet', 'elegoo', 'creality', 'snapmaker-luban', 'cloud', 'bambu', 'spoolman', 'home-assistant', 'rtsp-camera']

/** Which fixture printer backs each protocol. */
const BACKING: Record<string, string> = { moonraker: 'bay-4', prusalink: 'bay-3', octoprint: 'bay-2', duet: 'bay-4', elegoo: 'bay-4', creality: 'bay-5', 'snapmaker-luban': 'bay-2', bambu: 'bay-1' }

export interface StartOptions {
  only?: MockName[]
  /** Force every printer to this state at start. Lifecycle tests use `idle`. */
  state?: PrinterState
  /** Require the mock API key (PrusaLink, OctoPrint, Moonraker) and the Duet password. */
  auth?: boolean
  /** PrusaLink asks for HTTP digest login instead of an API key. */
  digest?: boolean
  /** Moonraker forces logins (`force_logins`), so only a user login or the API key gets in. */
  forceLogins?: boolean
  /** Give every printer a camera, including the ones the fixture says have none. */
  camera?: boolean
  fixturePath?: string
}

export interface RunningMocks {
  /** Ports by mock name. `rtsp-camera` (Basic login) and `rtsp-open` (none) are generic RTSP cameras. Bambu has five: `bambu` (MQTT), `bambu-ftp`, `bambu-camera` (JPEG stream), `bambu-rtsps` (X1 and H2 video), `bambu-ssdp` (UDP, answers searches). */
  ports: Record<string, number>
  control: number
  stop(): Promise<void>
}

export async function startMocks(opts: StartOptions = {}): Promise<RunningMocks> {
  // fileURLToPath, not URL.pathname: on Windows the pathname is /C:/..., which reads as C:\C:\...
  const path = opts.fixturePath ?? fileURLToPath(new URL('../../fixtures/demo-fleet.json', import.meta.url))
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as DemoFleet
  const only = opts.only ?? ALL_MOCKS
  const machines = new Map<string, MockMachine>()
  const log: string[] = []
  const servers: { close(cb?: () => void): unknown }[] = []
  const ports: Record<string, number> = {}
  const machine = (name: string) => {
    const m = new MockMachine(fixture, BACKING[name] ?? 'bay-1', opts.state)
    if (opts.camera) m.fx.cameraAvailable = true
    machines.set(name, m)
    return m
  }
  const apiKey = opts.auth ? MOCK_API_KEY : undefined
  const add = (name: string, r: { server: Server; port: number }) => { servers.push(r.server); ports[name] = r.port }

  let moonrakerControl: MoonrakerControl | undefined
  if (only.includes('moonraker')) {
    const r = await startMoonraker(machine('moonraker'), { ...(apiKey ? { apiKey } : {}), ...(opts.forceLogins ? { forceLogins: true } : {}) })
    moonrakerControl = r.control
    add('moonraker', r)
  }
  if (only.includes('prusalink')) add('prusalink', await startPrusaLink(machine('prusalink'), opts.digest ? { digest: MOCK_DIGEST } : apiKey ? { apiKey } : {}))
  if (only.includes('octoprint')) add('octoprint', await startOctoPrint(machine('octoprint'), apiKey ? { apiKey } : {}))
  if (only.includes('duet')) add('duet', await startDuet(machine('duet'), opts.auth ? { password: MOCK_DUET_PASSWORD } : {}))
  if (only.includes('elegoo')) add('elegoo', await startElegoo(machine('elegoo')))
  if (only.includes('creality')) {
    const c = await startCreality(machine('creality'), { log })
    servers.push(...c.servers)
    ports.creality = c.ports.ws
    ports['creality-http'] = c.ports.http
    ports['creality-camera'] = c.ports.camera
  }
  if (only.includes('snapmaker-luban')) add('snapmaker-luban', await startSnapmakerLuban(machine('snapmaker-luban')))
  let cloudOffer: ((spec: import('./cloud.ts').OfferSpec) => string) | undefined
  if (only.includes('cloud')) {
    const c = await startCloud(log)
    add('cloud', c)
    cloudOffer = c.offer
  }
  if (only.includes('spoolman')) add('spoolman', await startSpoolman(fixture, log))
  if (only.includes('home-assistant')) add('home-assistant', await startHomeAssistant(fixture, log))
  if (only.includes('rtsp-camera')) {
    const r = await startRtsp({ login: { user: MOCK_RTSP_CAMERA.user, pass: MOCK_RTSP_CAMERA.password, scheme: 'basic' }, path: MOCK_RTSP_CAMERA.path })
    servers.push(r.server)
    ports['rtsp-camera'] = r.port
    // The same camera with no login, for tests that must not touch the OS keychain.
    const open = await startRtsp({ path: MOCK_RTSP_CAMERA.path })
    servers.push(open.server)
    ports['rtsp-open'] = open.port
    // ONVIF fronts for the two cameras: `onvif` wants the login, `onvif-open` does not. Only the open
    // one answers WS-Discovery, on `onvif-discovery` (UDP).
    const onv = await startOnvif({ login: { user: MOCK_RTSP_CAMERA.user, pass: MOCK_RTSP_CAMERA.password }, rtspPort: r.port, rtspPath: MOCK_RTSP_CAMERA.path })
    const onvOpen = await startOnvif({ rtspPort: open.port, rtspPath: MOCK_RTSP_CAMERA.path })
    servers.push(onv.server, onvOpen.server, { close: (cb) => { onv.discovery.close(); onvOpen.discovery.close(cb) } })
    ports.onvif = onv.http
    ports['onvif-open'] = onvOpen.http
    ports['onvif-discovery'] = onvOpen.discoveryPort
  }
  let bambuExtra: BambuExtra | undefined
  if (only.includes('bambu')) {
    const b = await startBambu(machine('bambu'), log)
    bambuExtra = b.extra
    servers.push(b.handles.mqtt, b.handles.ftp, b.handles.camera, b.handles.rtsps.server, { close: (cb) => b.handles.ssdp.close(cb) })
    ports.bambu = b.ports.mqtt
    ports['bambu-ftp'] = b.ports.ftp
    ports['bambu-camera'] = b.ports.camera
    ports['bambu-rtsps'] = b.ports.rtsps
    ports['bambu-ssdp'] = b.ports.ssdp
  }

  // Control server: GET /state returns each machine's state, files and request log; POST /set changes one.
  const ctl = await listen((req) => {
    if (req.path === '/cloud/offer' && req.method === 'POST' && cloudOffer) {
      const b = req.json() as { printerLocalId: string; fileName: string; contentBase64: string; sha256?: string; bytes?: number; gcodePath?: string }
      const spec: import('./cloud.ts').OfferSpec = { printerLocalId: b.printerLocalId, fileName: b.fileName, content: Buffer.from(b.contentBase64, 'base64') }
      if (b.sha256 !== undefined) spec.sha256 = b.sha256
      if (b.bytes !== undefined) spec.bytes = b.bytes
      if (b.gcodePath !== undefined) spec.gcodePath = b.gcodePath
      return { json: { id: cloudOffer(spec) } }
    }
    // POST /set {mock, state}: moves a fake printer to a state, as if its job finished or failed
    // on its own. A finished or failed job keeps its name, as real printers show it.
    if (req.path === '/set' && req.method === 'POST') {
      const b = req.json() as { mock: string; state: PrinterState }
      const m = machines.get(b.mock)
      if (!m) return { status: 404 }
      m.state = b.state
      if (b.state === 'idle') m.job = undefined
      else if (m.job && b.state === 'finished') m.job = { ...m.job, progress: 1, timeLeftS: 0 }
      m.log.push(`set ${b.state}`)
      return { json: { state: m.state } }
    }
    // POST /bambu {refuse?, model?, ams?, external?, tagged?, liveview?}: the Bambu fake refuses project starts with `refuse` (null or
    // absent: accepts them); `model`, `ams` and `external` make it another printer (an A1 with an AMS lite, an A1 mini
    // with only the external spool). A connection made afterwards sees the new model. `tagged` lists the AMS
    // slots (0 based) whose spool has an RFID tag. `liveview: false` turns LAN Only Liveview off on an X1 or H2D;
    // `inBandParameterSets: true` makes its stream send SPS and PPS in band only; `cameraCode` makes its camera
    // want another code (null: the access code again); `digestQop: true` makes its Digest challenge offer qop;
    // `dropPlays: n` makes its camera drop the next n PLAY requests; `dropWithinMs` makes it drop a PLAY that
    // comes that soon after its last session ended; `stallCamera: true` makes the camera's playing sessions stop
    // sending frames with their connections left open. `printerType` puts a `printer_type` in its reports; `storage`
    // (`none`, `normal`, `abnormal`, `readonly`) is the SD card it reports, and `emmc: true` says it prints without one.
    if (req.path === '/bambu' && req.method === 'POST') {
      if (!bambuExtra) return { status: 404 }
      const b = req.json() as { refuse?: string | null; model?: string; ams?: BambuExtra['ams']; external?: BambuExtra['external'] | null; tagged?: number[]; liveview?: boolean; inBandParameterSets?: boolean; cameraCode?: string | null; digestQop?: boolean; dropPlays?: number; dropWithinMs?: number; stallCamera?: boolean; printerType?: string; storage?: BambuExtra['storage']; emmc?: boolean }
      if (b.printerType !== undefined) bambuExtra.printerType = b.printerType
      if (b.storage !== undefined) bambuExtra.storage = b.storage
      if (b.emmc !== undefined) bambuExtra.emmc = b.emmc
      if (b.liveview !== undefined) bambuExtra.liveview = b.liveview
      if (b.inBandParameterSets !== undefined) bambuExtra.inBandParameterSets = b.inBandParameterSets
      if (b.cameraCode) bambuExtra.cameraCode = b.cameraCode
      else if (b.cameraCode === null) delete bambuExtra.cameraCode
      if (b.digestQop !== undefined) bambuExtra.digestQop = b.digestQop
      if (b.dropPlays !== undefined) bambuExtra.dropPlays = b.dropPlays
      if (b.dropWithinMs !== undefined) bambuExtra.dropWithinMs = b.dropWithinMs
      if (b.stallCamera) bambuExtra.stalledAt = Date.now()
      if (b.tagged) bambuExtra.tagged = b.tagged
      if (b.refuse) bambuExtra.refuse = b.refuse
      else delete bambuExtra.refuse
      if (b.model) bambuExtra.model = b.model
      if (b.ams) bambuExtra.ams = b.ams
      if (b.external) bambuExtra.external = b.external
      else if (b.external === null) delete bambuExtra.external
      return { json: { refuse: bambuExtra.refuse ?? null, model: bambuExtra.model ?? null, ams: bambuExtra.ams ?? 'ams' } }
    }
    // POST /moonraker {variant?, klippy?, message?, expireTokens?}: see MoonrakerControl.
    if (req.path === '/moonraker' && req.method === 'POST') {
      if (!moonrakerControl) return { status: 404 }
      const b = req.json() as { variant?: MoonrakerControl['variant'] | null; klippy?: MoonrakerControl['klippy']; message?: string; expireTokens?: boolean }
      if (b.variant === null) delete moonrakerControl.variant
      else if (b.variant) moonrakerControl.variant = b.variant
      if (b.klippy) moonrakerControl.klippy = b.klippy
      if (b.message !== undefined) moonrakerControl.message = b.message
      if (b.expireTokens) moonrakerControl.tokens.clear()
      return { json: { variant: moonrakerControl.variant ?? null, klippy: moonrakerControl.klippy } }
    }
    // POST /motion {mock, homed?, position?, failG90?}: where the head is and which axes are homed.
    if (req.path === '/motion' && req.method === 'POST') {
      const b = req.json() as { mock: string; homed?: string; position?: [number, number, number]; failG90?: number }
      const m = machines.get(b.mock)
      if (!m) return { status: 404 }
      if (b.failG90 !== undefined) m.failG90 = b.failG90
      if (b.homed !== undefined) m.homed = b.homed
      if (b.position) m.position = b.position
      return { json: { homed: m.homed, position: m.position } }
    }
    // POST /slow {mock, uploadMs}: uploads take this long before the file lands.
    if (req.path === '/slow' && req.method === 'POST') {
      const b = req.json() as { mock: string; uploadMs: number }
      const m = machines.get(b.mock)
      if (!m) return { status: 404 }
      m.uploadDelayMs = Math.max(0, Number(b.uploadMs) || 0)
      return { json: { uploadMs: m.uploadDelayMs } }
    }
    // POST /replace {mock, name}: the file changes behind SlicerX's back (a USB stick, the
    // printer's own screen): new content, new size and time.
    if (req.path === '/replace' && req.method === 'POST') {
      const b = req.json() as { mock: string; name: string }
      const m = machines.get(b.mock)
      const f = m?.files.get(b.name)
      if (!m || !f) return { status: 404 }
      m.files.set(b.name, { ...f, size: f.size + 1, sha256: 'f'.repeat(64), modified: Date.now() / 1000 + 1 })
      m.log.push(`replace ${b.name}`)
      return { json: { replaced: true } }
    }
    if (req.path !== '/state') return { status: 404 }
    const out: Record<string, unknown> = { log }
    for (const [name, m] of machines) out[name] = { state: m.state, files: [...m.files.values()], log: m.log, position: m.position, relative: m.relative }
    return { json: out }
  })
  servers.push(ctl.server)

  return {
    ports,
    control: ctl.port,
    stop: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => { s.close(() => r()); (s as Server).closeAllConnections?.() })))
    },
  }
}
