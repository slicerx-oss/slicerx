// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// PrusaLink /api/v1 fake: https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml
// Every field and status code here is one that spec names; values the spec leaves open are the mock's own.
import { MockError, type MockMachine } from './machine.ts'
import { createHash, randomBytes } from 'node:crypto'
import { listen, offlineGate, type Handler, type Req } from './http-util.ts'

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

/** True when the request carries a valid RFC 7616 (MD5, qop=auth) Authorization header. */
function digestOk(req: Req, nonce: string, user: string, password: string): boolean {
  const h = String(req.headers.authorization ?? '')
  if (!h.startsWith('Digest ')) return false
  const f: Record<string, string> = {}
  for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) f[m[1] ?? ''] = m[2] ?? m[3] ?? ''
  if (f.username !== user || f.nonce !== nonce || f.qop !== 'auth') return false
  const uri = req.path + (req.query.size ? `?${req.query.toString()}` : '')
  if (f.uri !== uri) return false
  const ha1 = md5(`${user}:${f.realm}:${password}`)
  const ha2 = md5(`${req.method}:${f.uri}`)
  return f.response === md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:auth:${ha2}`)
}

const STATES: Record<string, string> = { idle: 'IDLE', printing: 'PRINTING', paused: 'PAUSED', finished: 'FINISHED', error: 'ERROR', preparing: 'BUSY', offline: 'IDLE' }

/** What the PrusaLink fake lists in `/api/v1/storage`: a USB drive (Buddy firmware), the printer's own `local` storage, or nothing writable. */
export type PrusaStorage = 'usb' | 'local' | 'none'

/** The layer height the fake's jobs report in their file metadata (`layer_height`, millimeters). */
const LAYER_MM = 0.2

/** What a runout leaves on the printer. The spec gives no runout text; its ATTENTION state is a printer waiting on the user. */
export const PRUSA_RUNOUT_MESSAGE = 'Filament runout'

const round2 = (n: number) => Math.round(n * 100) / 100

export async function startPrusaLink(m: MockMachine, opts: { apiKey?: string; digest?: { user: string; password: string }; extra?: { storage: PrusaStorage } } = {}) {
  const extra = opts.extra ?? { storage: 'usb' as PrusaStorage }
  const nonce = randomBytes(16).toString('hex')
  const active = () => m.job !== undefined && (m.state === 'printing' || m.state === 'paused')
  // A door is not a Prusa concept: PrusaLink reports none, so the door fault is only logged.
  m.faultProfile = { runoutMessage: PRUSA_RUNOUT_MESSAGE, door: false }
  // Offline: the next request gets the spec's 503 (Service Unavailable), then connections are refused until cleared.
  let served503 = false
  m.onChange(() => { if (!m.faults.has('offline')) served503 = false })
  // An upload in progress keeps the storage busy: a second one gets the spec's 409.
  let uploading = false
  const handler: Handler = async (req) => {
    if (m.faults.has('offline')) {
      served503 = true
      return { status: 503, json: { title: 'Service Unavailable', text: 'The printer is not available' }, headers: { connection: 'close' } }
    }
    if (opts.apiKey && req.headers['x-api-key'] !== opts.apiKey) return { status: 401, json: { message: 'unauthorized' } }
    if (opts.digest && !digestOk(req, nonce, opts.digest.user, opts.digest.password)) {
      return { status: 401, json: { message: 'unauthorized' }, headers: { 'www-authenticate': `Digest realm="Printer API", nonce="${nonce}", qop="auth", algorithm=MD5, opaque="mock"` } }
    }
    const p = req.path
    if (p === '/api/version') return { json: { api: '2.0.0', server: '2.1.2', text: 'PrusaLink', hostname: 'mock', firmware: '6.2.4+mock', nozzle_diameter: 0.4 } }
    if (p === '/api/v1/info') return { json: { name: m.fx.model, hostname: 'mock', serial: 'CZPXMOCK0001', nozzle_diameter: 0.4, mmu: false } }
    if (p === '/api/v1/storage') {
      const usb = { name: 'USB', type: 'USB', path: '/usb', available: extra.storage === 'usb', read_only: false }
      const local = { name: 'Local', type: 'LOCAL', path: '/local', available: extra.storage === 'local', read_only: false }
      return { json: { storage_list: [usb, local] } }
    }
    if (p === '/api/v1/status') {
      const printerState = m.message && m.state === 'paused' ? 'ATTENTION' : STATES[m.state]
      const t = { n: m.fx.nozzles[0], b: m.fx.bed }
      const moving = m.state === 'printing'
      // The head climbs with the layers while a job runs. The spec has axis_x and axis_y only while it is not moving.
      const z = active() && m.job ? round2(m.job.layer * LAYER_MM) : m.position[2]
      return {
        json: {
          job: active() && m.job ? { id: 1, progress: m.job.progress * 100, time_remaining: m.job.timeLeftS, time_printing: m.printedS } : undefined,
          storage: { path: '/usb/', name: 'usb', read_only: false },
          printer: {
            state: printerState, temp_nozzle: t.n?.current, target_nozzle: t.n?.target, temp_bed: t.b?.current, target_bed: t.b?.target,
            ...(moving ? {} : { axis_x: m.position[0], axis_y: m.position[1] }),
            axis_z: z, flow: 100, speed: 100,
            fan_hotend: m.state === 'idle' || m.state === 'offline' ? 0 : 5600, fan_print: moving ? 4200 : 0,
            // A runout's message, in the spec's status_printer {ok, message} shape.
            ...(m.message && m.faults.has('runout') ? { status_printer: { ok: false, message: m.message } } : {}),
          },
        },
      }
    }
    if (p === '/api/v1/job') {
      if (!active() || !m.job) return { status: 204 }
      const f = m.files.get(m.job.name)
      // The spec's Job has no current layer. Its file metadata has the layer height, the top layer's Z and the estimate.
      const meta = { layer_height: LAYER_MM, max_layer_z: round2(m.job.layerCount * LAYER_MM), estimated_print_time: m.printedS + m.job.timeLeftS, layer_info_present: true }
      return {
        json: {
          id: 1, state: STATES[m.state], progress: m.job.progress * 100, time_remaining: m.job.timeLeftS, time_printing: m.printedS, inaccurate_estimates: false,
          file: { name: m.job.name, display_name: m.job.name, path: `/${extra.storage === 'local' ? 'local' : 'usb'}`, size: f?.size ?? 0, m_timestamp: Math.floor(f?.modified ?? m.startedAt), meta },
        },
      }
    }
    if (p === '/api/v1/cameras') return { json: m.fx.cameraAvailable ? [{ camera_id: 'cam1', config: { name: 'Camera' } }] : [] }
    // The camera's picture follows `POST /camera`; `/api/v1/cameras/snap` is the default camera's.
    if (p === '/api/v1/cameras/cam1/snap' || p === '/api/v1/cameras/snap') return { body: m.frame(), type: 'image/jpeg' }
    const file = /^\/api\/v1\/files\/([^/]+)\/(.+)$/.exec(p)
    if (file) {
      const name = decodeURIComponent(file[2] ?? '')
      if (req.method === 'PUT') {
        if (file[1] !== extra.storage) throw new MockError(404, `no storage ${file[1]}`)
        // The spec's 409: the file is printing, or the storage is busy with another upload.
        if (active() && m.job?.name === name) throw new MockError(409, `${name} is printing`)
        if (uploading) throw new MockError(409, 'storage busy')
        uploading = true
        try {
          if (m.uploadDelayMs > 0) await new Promise((r) => setTimeout(r, m.uploadDelayMs))
          m.upload(name, req.body)
        } finally {
          uploading = false
        }
        return { status: 201, json: { name } }
      }
      if (req.method === 'POST') { m.start(name); return { status: 204 } }
    }
    const job = /^\/api\/v1\/job\/(\d+)(?:\/(pause|resume))?$/.exec(p)
    // The spec's 404 for an id that is not the running job's, and its 409 for pause or resume in the wrong state.
    if (job && active() && job[1] !== '1') throw new MockError(404, `no job ${job[1]}`)
    if (job && active()) {
      if (req.method === 'PUT' && job[2] === 'pause') { m.pause(); return { status: 204 } }
      if (req.method === 'PUT' && job[2] === 'resume') { m.resume(); return { status: 204 } }
      if (req.method === 'DELETE') { m.cancel(); return { status: 204 } }
    }
    throw new MockError(job ? 409 : 404, p)
  }
  const r = await listen(handler)
  offlineGate(r.server, () => m.faults.has('offline') && served503)
  return r
}
