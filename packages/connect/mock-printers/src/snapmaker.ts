// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Snapmaker 2.0 (A150, A250, A350) HTTP API fake, as Snapmaker Luban speaks it:
// https://github.com/Snapmaker/Luban (src/server/services/machine/channels/SstpHttpChannel.ts)
// The faults follow the status fields packages/connect/docs/snapmaker.md lists (`isFilamentOut`,
// `isEnclosureDoorOpen`) and its "is unreachable" case for a machine that dropped off the Wi-Fi. No camera.
import { randomBytes } from 'node:crypto'
import { MockError, type MockMachine } from './machine.ts'
import { listen, readFilePart, type Handler, type Req } from './http-util.ts'
import type { Socket } from 'node:net'

const STATUS: Record<string, string> = { idle: 'IDLE', finished: 'IDLE', error: 'IDLE', offline: 'IDLE', preparing: 'RUNNING', printing: 'RUNNING', paused: 'PAUSED' }

/**
 * `confirmAfter` status polls with a new token answer 204 (waiting for the tap on the touchscreen);
 * after that the token is authorized. Tokens are 32 hex characters, as on the printer.
 */
/**
 * Changed through the control server (`POST /snapmaker`): `drop` makes the next n status requests of
 * an authorized token answer 401, as an A350 does when it drops an idle session; `decline` makes
 * pairing prompts answer 401, as when No is tapped; `forget` clears every token, as a power cycle does.
 */
export interface LubanExtra { drop: number; decline: boolean; forget(): void }

export async function startSnapmakerLuban(m: MockMachine, opts: { confirmAfter?: number; headType?: number } = {}) {
  const confirmAfter = opts.confirmAfter ?? 2
  const tokens = new Map<string, { polls: number }>()
  const extra: LubanExtra = { drop: 0, decline: false, forget: () => tokens.clear() }
  let prepared: string | undefined

  const form = async (req: Req): Promise<URLSearchParams> => {
    const type = String(req.headers['content-type'] ?? '')
    if (type.startsWith('multipart/')) {
      const f = await req.form()
      const p = new URLSearchParams()
      for (const [k, v] of f.entries()) if (typeof v === 'string') p.set(k, v)
      return p
    }
    return new URLSearchParams(req.body.toString('utf8'))
  }
  const authed = (token: string | null): boolean => {
    const t = token ? tokens.get(token) : undefined
    return !!t && t.polls >= confirmAfter
  }

  // A runout and an open door are the status flags; the runout also pauses a running print. The machine leaves
  // no message of its own: the flags are what the status carries.
  m.faultProfile = { door: true }
  // Offline: the machine has dropped off the Wi-Fi. Requests get no answer at all, as to a machine that is gone,
  // until the client gives up; clearing the fault closes the held connections, and new ones are answered again.
  const held = new Set<Socket>()
  m.onChange(() => {
    if (m.faults.has('offline')) return
    for (const s of held) s.destroy()
    held.clear()
  })

  const handler: Handler = async (req) => {
    if (m.faults.has('offline')) return new Promise<never>(() => undefined)
    const p = req.path
    if (p === '/api/v1/connect' && req.method === 'POST') {
      const given = (await form(req)).get('token')
      const token = given && tokens.has(given) ? given : randomBytes(16).toString('hex')
      if (!tokens.has(token)) tokens.set(token, { polls: 0 })
      return { json: { token, series: 'Snapmaker 2.0 A350', headType: opts.headType ?? 1, hasEnclosure: true } }
    }
    if (p === '/api/v1/disconnect' && req.method === 'POST') {
      const token = (await form(req)).get('token')
      if (token && tokens.get(token)?.polls !== undefined && !authed(token)) tokens.delete(token)
      m.log.push('disconnect')
      return { json: {} }
    }
    if (p === '/api/v1/status' && req.method === 'GET') {
      // Luban sends the token in the query; a form body is read too.
      const token = req.query.get('token') ?? (req.body.length ? new URLSearchParams(req.body.toString('utf8')).get('token') : null)
      const t = token ? tokens.get(token) : undefined
      if (!t) return { status: 401, json: { code: 401 } }
      if (t.polls < confirmAfter) {
        if (extra.decline) { tokens.delete(token!); return { status: 401, json: { code: 401 } } }
        t.polls++
        return { status: 204 }
      }
      if (extra.drop > 0) { extra.drop--; return { status: 401, json: { code: 401 } } }
      const n = m.fx.nozzles[0]
      const active = m.state === 'printing' || m.state === 'paused'
      return {
        json: {
          status: STATUS[m.state],
          nozzleTemperature: n?.current ?? 0,
          nozzleTargetTemperature: n?.target ?? 0,
          heatedBedTemperature: m.fx.bed?.current ?? 0,
          heatedBedTargetTemperature: m.fx.bed?.target ?? 0,
          fileName: active && m.job ? m.job.name : '',
          progress: active && m.job ? m.job.progress : 0,
          elapsedTime: active ? m.printedS : 0,
          remainingTime: active && m.job ? m.job.timeLeftS : 0,
          totalLines: 1000,
          currentLine: active && m.job ? Math.round(m.job.progress * 1000) : 0,
          isEnclosureDoorOpen: m.faults.has('door'),
          isFilamentOut: m.faults.has('runout'),
          homed: true,
          x: m.position[0], y: m.position[1], z: m.position[2],
        },
      }
    }
    if (p === '/api/v1/enclosure' && req.method === 'GET') return { json: { isReady: true, isDoorEnabled: true, led: 50, fan: 0 } }
    if (!['/api/v1/prepare_print', '/api/v1/start_print', '/api/v1/pause_print', '/api/v1/resume_print', '/api/v1/stop_print', '/api/v1/execute_code'].includes(p)) throw new MockError(404, p)
    // Everything below needs an authorized token.
    const f = req.method === 'POST' ? await form(req) : req.query
    if (!authed(f.get('token'))) return { status: 401, json: { code: 401 } }
    if (p === '/api/v1/prepare_print') {
      const file = await readFilePart(req)
      m.upload(file.name, file.data)
      prepared = file.name
      return { json: {} }
    }
    if (p === '/api/v1/start_print') { if (!prepared) throw new MockError(404, 'nothing prepared'); m.start(prepared); return { json: {} } }
    if (p === '/api/v1/pause_print') { m.pause(); return { json: {} } }
    if (p === '/api/v1/resume_print') { m.resume(); return { json: {} } }
    if (p === '/api/v1/stop_print') { m.cancel(); return { json: {} } }
    if (p === '/api/v1/execute_code') { m.gcode(f.get('code') ?? ''); return { json: { result: 0 }, type: 'application/json' } }
    throw new MockError(404, p)
  }
  const r = await listen(handler)
  r.server.prependListener('request', (rq: { socket: Socket }) => { if (m.faults.has('offline')) held.add(rq.socket) })
  return { ...r, extra }
}
