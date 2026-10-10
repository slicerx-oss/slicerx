// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/mock-printers. See README.md for the public API.
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { DemoFleet, PrinterState } from '@slicerx/contracts'
import { startOnvif } from './onvif.ts'
import { startRtsp } from './rtsp.ts'
import { startAnycubic, type AnycubicExtra } from './anycubic.ts'
import { startBambu, MOCK_ACCESS_CODE, MOCK_SERIAL, type BambuExtra } from './bambu.ts'
import { MOCK_CLOUD_TOKEN, startCloud } from './cloud.ts'
import { startCreality, type CrealityControl } from './creality.ts'
import { startDuet } from './duet.ts'
import { startElegoo, type ElegooExtra } from './elegoo.ts'
import { listen } from './http-util.ts'
import { MockMachine, type CameraFrame, type Fault } from './machine.ts'
import { MOCK_MOONRAKER_LOGIN, startMoonraker, type MoonrakerControl } from './moonraker.ts'
import { startOctoPrint } from './octoprint.ts'
import { startSnapmakerLuban, type LubanExtra } from './snapmaker.ts'
import { startPrusaLink, type PrusaStorage } from './prusalink.ts'
import { startUltiMaker } from './ultimaker.ts'
import { MOCK_HA_TOKEN, startHomeAssistant, startSpoolman } from './services.ts'

export { MOCK_ACCESS_CODE, MOCK_SERIAL, MOCK_HA_TOKEN, MOCK_CLOUD_TOKEN, MOCK_MOONRAKER_LOGIN }

export const MOCK_API_KEY = 'mock-api-key'
export const MOCK_DUET_PASSWORD = 'mock-reprap'
export const MOCK_DIGEST = { user: 'maker', password: 'mock-digest-pass' }

/** Login of the generic RTSP camera mock (`rtsp://HOST:PORT/live`, Basic). */
export const MOCK_RTSP_CAMERA = { user: 'cam', password: 'cam-pass', path: '/live' }

export type MockName = 'moonraker' | 'prusalink' | 'octoprint' | 'duet' | 'elegoo' | 'creality' | 'snapmaker-luban' | 'snapmaker-u1' | 'ultimaker' | 'anycubic' | 'cloud' | 'bambu' | 'spoolman' | 'home-assistant' | 'rtsp-camera'
export const ALL_MOCKS: MockName[] = ['moonraker', 'prusalink', 'octoprint', 'duet', 'elegoo', 'creality', 'snapmaker-luban', 'snapmaker-u1', 'ultimaker', 'anycubic', 'cloud', 'bambu', 'spoolman', 'home-assistant', 'rtsp-camera']

/** Which fixture printer backs each protocol. */
const BACKING: Record<string, string> = { moonraker: 'bay-4', prusalink: 'bay-3', octoprint: 'bay-2', duet: 'bay-4', elegoo: 'bay-4', creality: 'bay-5', 'snapmaker-luban': 'bay-2', 'snapmaker-u1': 'bay-4', ultimaker: 'bay-4', anycubic: 'bay-4', bambu: 'bay-1' }

/** The mocks whose camera sends the frame `POST /camera` picks. */
const CAMERA_MOCKS = new Set(['prusalink', 'elegoo', 'snapmaker-u1', 'moonraker', 'bambu'])

/** The job tick `--tick` turns on: 36 s of print a second, 1% of a fresh hour long job. */
export const DEFAULT_TICK = { everyMs: 1000, seconds: 36 }

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
  /** Move printing jobs on by themselves: `true` is `DEFAULT_TICK`. Off by default, so states only change on request. */
  tick?: boolean | { everyMs: number; seconds: number }
  fixturePath?: string
}

export interface RunningMocks {
  /** Ports by mock name. `anycubic` is the Anycubic /info port, `anycubic-mqtt` its broker. `ultimaker-camera` is the UltiMaker camera (mjpg-streamer). `rtsp-camera` (Basic login) and `rtsp-open` (none) are generic RTSP cameras. Bambu has five: `bambu` (MQTT), `bambu-ftp`, `bambu-camera` (JPEG stream), `bambu-rtsps` (X1 and H2 video), `bambu-ssdp` (UDP, answers searches). */
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
    if (opts.tick) { const t = opts.tick === true ? DEFAULT_TICK : opts.tick; m.autoTick(t.everyMs, t.seconds) }
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
  const prusaExtra = { storage: 'usb' as PrusaStorage }
  if (only.includes('prusalink')) add('prusalink', await startPrusaLink(machine('prusalink'), { ...(opts.digest ? { digest: MOCK_DIGEST } : apiKey ? { apiKey } : {}), extra: prusaExtra }))
  if (only.includes('octoprint')) add('octoprint', await startOctoPrint(machine('octoprint'), apiKey ? { apiKey } : {}))
  if (only.includes('duet')) add('duet', await startDuet(machine('duet'), opts.auth ? { password: MOCK_DUET_PASSWORD } : {}))
  const elegooExtra: ElegooExtra = { remainingMemory: 8_000_000_000 }
  if (only.includes('elegoo')) add('elegoo', await startElegoo(machine('elegoo'), elegooExtra))
  let crealityControl: CrealityControl | undefined
  if (only.includes('creality')) {
    const c = await startCreality(machine('creality'), { log })
    crealityControl = c.control
    servers.push(...c.servers)
    ports.creality = c.ports.ws
    ports['creality-http'] = c.ports.http
    ports['creality-camera'] = c.ports.camera
  }
  let lubanExtra: LubanExtra | undefined
  if (only.includes('snapmaker-luban')) {
    const l = await startSnapmakerLuban(machine('snapmaker-luban'))
    lubanExtra = l.extra
    add('snapmaker-luban', l)
  }
  // The Snapmaker U1: Moonraker with the U1's objects and host name, and one webcam.
  if (only.includes('snapmaker-u1')) add('snapmaker-u1', await startMoonraker(machine('snapmaker-u1'), { ...(apiKey ? { apiKey } : {}), variant: 'u1', webcam: true }))
  if (only.includes('ultimaker')) {
    const u = await startUltiMaker(machine('ultimaker'))
    add('ultimaker', u.api)
    add('ultimaker-camera', u.camera)
  }
  let anycubicExtra: AnycubicExtra | undefined
  if (only.includes('anycubic')) {
    const a = await startAnycubic(machine('anycubic'), log)
    anycubicExtra = a.extra
    add('anycubic', a.http)
    servers.push(a.mqtt)
    ports['anycubic-mqtt'] = a.mqttPort
  }
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
  // What `POST /bambu {cameraFrame, cameraFrameFile}` set, kept apart so dropping the file brings the hand back.
  let bambuCamera: { hand: boolean; file?: string } = { hand: false }
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
      m.changed()
      return { json: { state: m.state } }
    }
    // POST /camera {mock, frame}: what that mock's camera sends from now on. `frame` is `placeholder` (the tiny
    // JPEG), `hand` (HAND_FRAME, a hand reaching in) or the path of a JPEG file, read for each frame.
    if (req.path === '/camera' && req.method === 'POST') {
      const b = req.json() as { mock: string; frame: string }
      const m = machines.get(b.mock)
      if (!m) return { status: 404 }
      if (!CAMERA_MOCKS.has(b.mock)) return { status: 400, json: { error: `${b.mock} has no camera that follows /camera` } }
      if (typeof b.frame !== 'string' || !b.frame) return { status: 400, json: { error: 'frame is placeholder, hand or a file path' } }
      const frame: CameraFrame = b.frame === 'placeholder' || b.frame === 'hand' ? b.frame : { file: b.frame }
      m.setCamera(frame)
      if (b.mock === 'bambu') bambuCamera = { hand: frame === 'hand', ...(typeof frame === 'object' ? { file: frame.file } : {}) }
      return { json: { camera: b.frame } }
    }
    // POST /fault {mock, kind}: `runout`, `door`, `offline` or `clear`, each as that brand reports it (see README).
    if (req.path === '/fault' && req.method === 'POST') {
      const b = req.json() as { mock: string; kind: Fault | 'clear' }
      const m = machines.get(b.mock)
      if (!m) return { status: 404 }
      if (!['runout', 'door', 'offline', 'clear'].includes(b.kind)) return { status: 400, json: { error: 'kind is runout, door, offline or clear' } }
      if (!m.faultProfile) return { status: 400, json: { error: `${b.mock} takes no faults` } }
      m.fault(b.kind)
      return { json: { state: m.state, faults: [...m.faults] } }
    }
    // POST /tick {mock, seconds?, everyMs?}: moves a printing job on by `seconds` now, or, with `everyMs`, every
    // `everyMs` from now on (0 stops it).
    if (req.path === '/tick' && req.method === 'POST') {
      const b = req.json() as { mock: string; seconds?: number; everyMs?: number }
      const m = machines.get(b.mock)
      if (!m) return { status: 404 }
      if (b.everyMs !== undefined) m.autoTick(Math.max(0, Number(b.everyMs) || 0), Number(b.seconds ?? DEFAULT_TICK.seconds))
      else if (b.seconds !== undefined) m.tick(Number(b.seconds))
      return { json: { state: m.state, job: m.job ?? null } }
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
    // `developerMode: false` makes it a printer with Developer Mode off: status only, every command and upload refused
    // (null: no `fun` flags in its reports, as before). `cameraFrame: 'hand'` makes its JPEG camera show a hand reaching
    // in (null: the placeholder again); `cameraFrameFile` sends that JPEG file instead, a photo for a capture (null: off).
    if (req.path === '/bambu' && req.method === 'POST') {
      if (!bambuExtra) return { status: 404 }
      const b = req.json() as { refuse?: string | null; model?: string; ams?: BambuExtra['ams']; external?: BambuExtra['external'] | null; tagged?: number[]; liveview?: boolean; inBandParameterSets?: boolean; cameraCode?: string | null; digestQop?: boolean; dropPlays?: number; dropWithinMs?: number; stallCamera?: boolean; printerType?: string; storage?: BambuExtra['storage']; emmc?: boolean; developerMode?: boolean | null; cameraFrame?: 'hand' | null; cameraFrameFile?: string | null }
      if (b.printerType !== undefined) bambuExtra.printerType = b.printerType
      if (b.storage !== undefined) bambuExtra.storage = b.storage
      if (b.emmc !== undefined) bambuExtra.emmc = b.emmc
      if (b.developerMode === null) delete bambuExtra.developerMode
      else if (b.developerMode !== undefined) bambuExtra.developerMode = b.developerMode
      // The older names for `POST /camera`: a file wins over the hand, and dropping the file shows the hand again.
      if (b.cameraFrame !== undefined || b.cameraFrameFile !== undefined) {
        if (b.cameraFrame !== undefined) bambuCamera.hand = b.cameraFrame === 'hand'
        if (b.cameraFrameFile === null) delete bambuCamera.file
        else if (b.cameraFrameFile) bambuCamera.file = b.cameraFrameFile
        machines.get('bambu')?.setCamera(bambuCamera.file ? { file: bambuCamera.file } : bambuCamera.hand ? 'hand' : 'placeholder')
      }
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
    // POST /creality {model?, modelVersion?, webrtc?, cfs?, refuseSubprotocol?}: see CrealityControl.
    if (req.path === '/creality' && req.method === 'POST') {
      if (!crealityControl) return { status: 404 }
      Object.assign(crealityControl, req.json() as Partial<CrealityControl>)
      return { json: crealityControl }
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
    // POST /elegoo {remainingMemory}: the free storage the Elegoo fake's attributes report, in bytes.
    if (req.path === '/elegoo' && req.method === 'POST') {
      const b = req.json() as { remainingMemory?: number }
      if (b.remainingMemory !== undefined) elegooExtra.remainingMemory = b.remainingMemory
      return { json: { remainingMemory: elegooExtra.remainingMemory } }
    }
    // POST /snapmaker {drop?, decline?, forget?}: the Snapmaker 2.0 fake drops the next `drop` status
    // requests with a 401, answers pairing prompts with a refusal, or forgets every token.
    if (req.path === '/snapmaker' && req.method === 'POST') {
      if (!lubanExtra) return { status: 404 }
      const b = req.json() as { drop?: number; decline?: boolean; forget?: boolean }
      if (b.drop !== undefined) lubanExtra.drop = b.drop
      if (b.decline !== undefined) lubanExtra.decline = b.decline
      if (b.forget) lubanExtra.forget()
      return { json: { drop: lubanExtra.drop, decline: lubanExtra.decline } }
    }
    // POST /anycubic {cloud?, rotate?}: the Anycubic fake turns LAN Mode off (cloud: true), or changes its broker
    // login as a restart does (rotate: true), which drops the connected clients.
    if (req.path === '/anycubic' && req.method === 'POST') {
      if (!anycubicExtra) return { status: 404 }
      const b = req.json() as { cloud?: boolean; rotate?: boolean }
      if (b.cloud !== undefined) anycubicExtra.cloud = b.cloud
      if (b.rotate) anycubicExtra.rotate()
      return { json: { cloud: anycubicExtra.cloud } }
    }
    // POST /prusalink {storage}: what the PrusaLink fake lists as writable (`usb`, `local` or `none`).
    if (req.path === '/prusalink' && req.method === 'POST') {
      const b = req.json() as { storage?: PrusaStorage }
      if (b.storage) prusaExtra.storage = b.storage
      return { json: { storage: prusaExtra.storage } }
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
    for (const [name, m] of machines) out[name] = { state: m.state, files: [...m.files.values()], log: m.log, position: m.position, relative: m.relative, job: m.job ?? null, faults: [...m.faults], camera: typeof m.camera === 'object' ? m.camera.file : m.camera }
    return { json: out }
  })
  servers.push(ctl.server)

  return {
    ports,
    control: ctl.port,
    stop: async () => {
      for (const m of machines.values()) m.autoTick(0, 0)
      await Promise.all(servers.map((s) => new Promise<void>((r) => { s.close(() => r()); (s as Server).closeAllConnections?.() })))
    },
  }
}
