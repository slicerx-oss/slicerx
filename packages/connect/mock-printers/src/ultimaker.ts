// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// UltiMaker S series fake: the printer API (/api/v1) and the cluster API (/cluster-api/v1) as UltiMaker
// Cura's network plugin uses them, and the mjpg-streamer camera on its own port.
// https://github.com/Ultimaker/Cura/tree/main/plugins/UM3NetworkPrinting
import { createHash, randomBytes } from 'node:crypto'
import { JPEG, MockError, type MockMachine } from './machine.ts'
import { listen, mjpeg, readFilePart, type Handler } from './http-util.ts'

export const MOCK_UM_GUID = 'e6a1c3f2-0000-4000-8000-00000000c0de'
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

const JOB_STATE: Record<string, string> = { printing: 'printing', paused: 'paused', preparing: 'pre_print', finished: 'wait_cleanup' }

/** `authorizeAfter` auth/check polls answer `unknown` before `authorized`, as the touchscreen prompt waits for a tap. */
export async function startUltiMaker(m: MockMachine, opts: { authorizeAfter?: number } = {}) {
  const pairs = new Map<string, { key: string; checks: number }>()
  const nonce = randomBytes(8).toString('hex')
  const job = () => {
    const state = JOB_STATE[m.state]
    if (!state || !m.job) return undefined
    return { uuid: 'job-1', name: m.job.name, state, result: m.state === 'finished' ? 'Finished' : '', progress: m.job.progress, time_elapsed: 600, time_total: 600 + m.job.timeLeftS }
  }
  const digestOk = (h: string, method: string, uri: string): boolean => {
    if (!h.startsWith('Digest ')) return false
    const f: Record<string, string> = {}
    for (const x of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) f[x[1] ?? ''] = x[2] ?? x[3] ?? ''
    const pair = pairs.get(f.username ?? '')
    if (!pair || f.nonce !== nonce || f.uri !== uri) return false
    const ha1 = md5(`${f.username}:${f.realm}:${pair.key}`)
    const ha2 = md5(`${method}:${uri}`)
    const expect = f.qop ? md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:auth:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`)
    return f.response === expect
  }
  const handler: Handler = async (req) => {
    const p = req.path
    if (p === '/api/v1/system') return { json: { name: m.fx.name, hostname: 'ultimakersystem-mock', platform: 'Linux', variant: 'Ultimaker S5', firmware: '7.4.1', guid: MOCK_UM_GUID, hardware: { typeid: 9051, revision: 0 } } }
    if (p === '/api/v1/printer') {
      const n = m.fx.nozzles[0]
      return {
        json: {
          status: m.state === 'error' ? 'error' : JOB_STATE[m.state] && m.state !== 'finished' ? 'printing' : 'idle',
          bed: { temperature: { current: m.fx.bed?.current ?? 22, target: m.fx.bed?.target ?? 0 } },
          heads: [{ extruders: [
            { hotend: { id: 'AA 0.4', temperature: { current: n?.current ?? 25, target: n?.target ?? 0 } } },
            { hotend: { id: 'BB 0.4', temperature: { current: 25, target: 0 } } },
          ] }],
          ...(m.fx.cameraAvailable ? { camera: { feed: 'http://127.0.0.1:8080/?action=stream' } } : {}),
        },
      }
    }
    if (p === '/api/v1/print_job') { const j = job(); return j ? { json: j } : { status: 404, json: { message: 'No print job' } } }
    if (p === '/api/v1/auth/request' && req.method === 'POST') {
      const id = randomBytes(16).toString('hex')
      const key = randomBytes(32).toString('hex')
      pairs.set(id, { key, checks: 0 })
      return { json: { id, key } }
    }
    const check = /^\/api\/v1\/auth\/check\/(\w+)$/.exec(p)
    if (check) {
      const pair = pairs.get(check[1] ?? '')
      if (!pair) return { json: { message: 'unknown' } }
      pair.checks++
      return { json: { message: pair.checks > (opts.authorizeAfter ?? 2) ? 'authorized' : 'unknown' } }
    }
    if (p === '/api/v1/auth/verify') {
      if (digestOk(String(req.headers.authorization ?? ''), req.method, p)) return { json: { message: 'ok' } }
      return { status: 401, json: { message: 'Authorization required.' }, headers: { 'www-authenticate': `Digest realm="Jedi-API", nonce="${nonce}", qop="auth"` } }
    }
    if (p === '/cluster-api/v1/printers') {
      return {
        json: [{
          uuid: MOCK_UM_GUID, unique_name: 'ultimakersystem-mock', friendly_name: m.fx.name, machine_variant: 'Ultimaker S5', status: 'idle', enabled: true, ip_address: '127.0.0.1', firmware_version: '7.4.1',
          configuration: [
            { extruder_index: 0, print_core_id: 'AA 0.4', material: { material: 'PLA', color: '#ffc924', brand: 'Ultimaker', guid: 'pla-guid' } },
            { extruder_index: 1, print_core_id: 'BB 0.4', material: { material: 'PVA', color: '#f0f0f0', brand: 'Ultimaker', guid: 'pva-guid' } },
          ],
        }],
      }
    }
    if (p === '/cluster-api/v1/print_jobs/' && req.method === 'POST') {
      const f = await readFilePart(req)
      m.upload(f.name, f.data)
      m.start(f.name)
      return { status: 201, json: { uuid: 'job-1' } }
    }
    const action = /^\/cluster-api\/v1\/print_jobs\/([\w-]+)\/action$/.exec(p)
    if (action && req.method === 'PUT') {
      const a = (req.json() as { action?: string }).action
      if (a === 'pause') m.pause()
      else if (a === 'print') m.resume()
      else if (a === 'abort') m.cancel()
      else throw new MockError(400, `action ${a}`)
      return { status: 204 }
    }
    throw new MockError(404, p)
  }
  const api = await listen(handler)
  const camera = await listen((req) => {
    if (!m.fx.cameraAvailable) throw new MockError(404, 'no camera')
    return req.query.get('action') === 'snapshot' ? { body: JPEG, type: 'image/jpeg' } : { stream: mjpeg(JPEG) }
  })
  return { api, camera }
}
