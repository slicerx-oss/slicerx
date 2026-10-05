// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Replay time for 5, 20 and 50 steps on a bracket-sized part, against the live engine. Off by default:
// SX_HISTORY_BENCH=1 (with a built engine) runs it and prints the table.
import { describe, expect, it } from 'vitest'
import { wasmGeom, liveEngine } from './geom-engine'
import type { MeshPart } from '@slicerx/contracts'
import type { History, StepParams } from '../src/cad/history/model'
import { withStep } from '../src/cad/history/record'
import { clearReplayCache, replayHistory, type EngineCall } from '../src/cad/history/replay'
import { boxMesh } from '../src/plate/mesh-ops'

const on = process.env['SX_HISTORY_BENCH'] === '1' && liveEngine
const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const top = (z: number) => ({ origin: [100, 100, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] })

/** A 80 by 40 by 6 mm bracket foot with `n` steps: holes in a grid, bosses, and a pull of the far end every few steps. */
function bracket(n: number): History {
  let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: [boxMesh(80, 40, 6)], transform: T }
  let pulls = 0
  for (let i = 0; i < n; i++) {
    const col = i % 10
    const row = Math.floor(i / 10) % 5
    const x = -36 + col * 8
    const y = -16 + row * 8
    let params: StepParams
    if (i % 5 === 4) params = { op: 'face.push', at: [140 + pulls++, 100, 3], normal: [1, 0, 0], distanceMm: 1 }
    else if (i % 2 === 0) params = { op: 'shape.extrude', frame: top(6), shape: { type: 'circle', diameterMm: 3 }, placement: { center: [x, y] }, spec: { distanceMm: 4, operation: 'cut' } }
    else params = { op: 'shape.extrude', frame: top(6), shape: { type: 'rectangle', widthMm: 4, heightMm: 3, cornerRadiusMm: 1 }, placement: { center: [x, y] }, spec: { distanceMm: 3, operation: 'join' } }
    e = { ...e, history: withStep(e, 0, params) }
  }
  return e.history!
}

async function time(call: EngineCall, h: History): Promise<number> {
  const t = performance.now()
  const r = await replayHistory(call, { history: h })
  expect(r.status.find((s) => s.state !== 'done')).toBeUndefined()
  return performance.now() - t
}

describe.skipIf(!on)('history replay time', () => {
  it('replays 5, 20 and 50 steps', async () => {
    const g = await wasmGeom()
    const call: EngineCall = (op, r) => g.call(op, r)
    const rows: string[] = ['| Steps | Triangles at the end | Full replay | Edit the first step | Edit the middle step | Edit the last step |', '| --- | --- | --- | --- | --- | --- |']
    for (const n of [5, 20, 50]) {
      const h = bracket(n)
      clearReplayCache()
      await time(call, h) // warm the engine
      clearReplayCache()
      const full = await time(call, h)
      const r = await replayHistory(call, { history: h })
      const edit = async (k: number) => {
        const s = h.steps[k]!
        const params: StepParams = s.params.op === 'face.push' ? { ...s.params, distanceMm: 1.5 } : s.params.op === 'shape.extrude' ? { ...s.params, spec: { ...s.params.spec, distanceMm: s.params.spec.distanceMm + 0.5 } } : s.params
        return time(call, { ...h, steps: h.steps.map((x, i) => (i === k ? { ...x, params } : x)) })
      }
      const first = await edit(0)
      const middle = await edit(Math.floor(n / 2))
      const last = await edit(n - 1)
      rows.push(`| ${n} | ${r.parts[0]!.indices.length / 3} | ${full.toFixed(0)} ms | ${first.toFixed(0)} ms | ${middle.toFixed(0)} ms | ${last.toFixed(0)} ms |`)
    }
    console.log(rows.join('\n'))
  }, 600_000)
})
