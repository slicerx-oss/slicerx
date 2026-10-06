// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// PrusaLink /api/v1 fake: https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml
import { JPEG, MockError, type MockMachine } from './machine.ts'
import { createHash, randomBytes } from 'node:crypto'
import { listen, type Handler, type Req } from './http-util.ts'

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

export async function startPrusaLink(m: MockMachine, opts: { apiKey?: string; digest?: { user: string; password: string }; extra?: { storage: PrusaStorage } } = {}) {
  const extra = opts.extra ?? { storage: 'usb' as PrusaStorage }
  const nonce = randomBytes(16).toString('hex')
  const active = () => m.job !== undefined && (m.state === 'printing' || m.state === 'paused')
  const handler: Handler = async (req) => {
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
      return {
        json: {
          job: active() && m.job ? { id: 1, progress: m.job.progress * 100, time_remaining: m.job.timeLeftS, time_printing: 0 } : undefined,
          storage: { path: '/usb/', name: 'usb', read_only: false },
          printer: { state: printerState, temp_nozzle: t.n?.current, target_nozzle: t.n?.target, temp_bed: t.b?.current, target_bed: t.b?.target },
        },
      }
    }
    if (p === '/api/v1/job') {
      if (!active() || !m.job) return { status: 204 }
      return { json: { id: 1, state: STATES[m.state], progress: m.job.progress * 100, time_remaining: m.job.timeLeftS, file: { name: m.job.name, display_name: m.job.name } } }
    }
    if (p === '/api/v1/cameras') return { json: m.fx.cameraAvailable ? [{ camera_id: 'cam1', config: { name: 'Camera' } }] : [] }
    if (p === '/api/v1/cameras/cam1/snap') return { body: JPEG, type: 'image/jpeg' }
    const file = /^\/api\/v1\/files\/([^/]+)\/(.+)$/.exec(p)
    if (file) {
      const name = decodeURIComponent(file[2] ?? '')
      if (req.method === 'PUT') {
        if (file[1] !== extra.storage) throw new MockError(404, `no storage ${file[1]}`)
        // The spec's 409: the file is printing, or the storage is busy.
        if (active() && m.job?.name === name) throw new MockError(409, `${name} is printing`)
        m.upload(name, req.body)
        return { status: 201, json: { name } }
      }
      if (req.method === 'POST') { m.start(name); return { status: 204 } }
    }
    const job = /^\/api\/v1\/job\/(\d+)(?:\/(pause|resume))?$/.exec(p)
    if (job && active()) {
      if (req.method === 'PUT' && job[2] === 'pause') { m.pause(); return { status: 204 } }
      if (req.method === 'PUT' && job[2] === 'resume') { m.resume(); return { status: 204 } }
      if (req.method === 'DELETE') { m.cancel(); return { status: 204 } }
    }
    throw new MockError(job ? 409 : 404, p)
  }
  return listen(handler)
}
