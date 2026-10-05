// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// RepRapFirmware standalone HTTP fake (rr_connect, rr_model, rr_gcode, rr_upload):
// https://github.com/Duet3D/RepRapFirmware/wiki/HTTP-requests
import { MockError, type MockMachine } from './machine.ts'
import { listen, type Handler } from './http-util.ts'

const STATES: Record<string, string> = { idle: 'idle', printing: 'processing', paused: 'paused', finished: 'idle', error: 'halted', preparing: 'starting', offline: 'off' }

export async function startDuet(m: MockMachine, opts: { password?: string } = {}) {
  const password = opts.password ?? 'reprap'
  const handler: Handler = async (req) => {
    const p = req.path
    if (p === '/rr_connect') return { json: { err: req.query.get('password') === password ? 0 : 1, sessionTimeout: 8000, boardType: 'mock' } }
    if (p === '/rr_model') {
      const heaters: { current: number; active: number; state: string }[] = []
      const tools = m.fx.nozzles.map((n, i) => { heaters.push({ current: n.current, active: n.target, state: 'active' }); return { number: i, heaters: [heaters.length - 1] } })
      const bedHeaters: number[] = []
      if (m.fx.bed) { heaters.push({ current: m.fx.bed.current, active: m.fx.bed.target, state: 'active' }); bedHeaters.push(heaters.length - 1) }
      const jobActive = m.job !== undefined && (m.state === 'printing' || m.state === 'paused')
      const size = 1_000_000
      return {
        json: {
          key: '', flags: 'd99vn',
          result: {
            state: { status: STATES[m.state] },
            job: {
              file: jobActive && m.job ? { fileName: `0:/gcodes/${m.job.name}`, size, numLayers: m.job.layerCount } : { fileName: null, size: 0, numLayers: null },
              filePosition: jobActive && m.job ? Math.round(m.job.progress * size) : 0,
              layer: jobActive ? m.job?.layer : null,
              timesLeft: { file: jobActive ? m.job?.timeLeftS : null },
              lastFileName: m.job?.name ?? null,
            },
            heat: { heaters, bedHeaters, chamberHeaters: [] },
            move: { axes: ['X', 'Y', 'Z'].map((letter, i) => ({ letter, homed: m.homed.includes(letter.toLowerCase()), userPosition: m.position[i], min: m.axisMin[i], max: m.axisMax[i] })) },
            tools,
          },
        },
      }
    }
    if (p === '/rr_gcode') {
      const g = req.query.get('gcode') ?? ''
      const start = /^M32 "(?:0:\/gcodes\/)?([^"]+)"$/.exec(g)
      if (start) m.start(start[1] ?? '')
      else if (g === 'M25') m.pause()
      else if (g === 'M24') m.resume()
      else if (g === 'M0') m.cancel()
      else m.gcode(g)
      return { json: { buff: 240 } }
    }
    if (p === '/rr_upload' && req.method === 'POST') {
      const name = (req.query.get('name') ?? '').replace(/^0:\/gcodes\//, '')
      m.upload(name, req.body)
      return { json: { err: 0 } }
    }
    throw new MockError(404, p)
  }
  return listen(handler)
}
