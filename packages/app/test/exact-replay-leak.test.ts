// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Kept bodies don't leak: 200 exact replays on the B-rep kernel's wasm module, as the geometry worker runs them
// (keepsBodies), with edits that miss the cache and cancels part way, then the cache cleared. The kernel's live
// body count stays bounded and comes back to zero.
import { readFileSync } from 'node:fs'
import { beforeEach, expect, it } from 'vitest'
import { IDENTITY, clearReplayCache, replayHistory, type History, type Step, type StepParams } from '@slicerx/cad-history'
import init from '../../brep/lib/sx_brep.mjs'
import { brepModule } from '../src/geom/brep'

const wasm = readFileSync(new URL('../../brep/lib/sx_brep.wasm', import.meta.url))

const step = (id: string, params: StepParams): Step => ({ id, part: 0, transform: [...IDENTITY], params })
const frame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

/** A plate 20 x 10 x 5 mm with a hole, a rounded and a beveled corner and a cut, its sizes from `i`. */
function history(i: number): History {
  const steps: Step[] = [
    step('box', { op: 'shape.extrude', frame, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams),
    step('hole', { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 2 + (i % 4) * 0.5, heightMm: 5 }], label: 'Hole' } as StepParams),
    step('round', { op: 'edge.fillet', edges: [{ a: [10, -5, 0], b: [10, -5, 5], face: [1, 0, 0] }], radiusMm: 1 + (i % 5) * 0.2 }),
    step('bevel', { op: 'edge.chamfer', edges: [{ a: [-10, -5, 0], b: [-10, -5, 5], face: [-1, 0, 0] }], distanceMm: 1 + (i % 3) * 0.25 }),
    step('cut', { op: 'plane.cut', plane: { point: [0, 0, 1 + (i % 6) * 0.5], normal: [0, 0, 1] }, keep: 'both' } as StepParams),
  ]
  return { version: 1, base: [], steps }
}

beforeEach(() => clearReplayCache())

it('frees every kept body once no cached step holds it, through edits and cancels', async () => {
  const kernel = brepModule(await init({ wasmBinary: wasm }))
  const live = () => (kernel.call('count', {}) as { bodies: number }).bodies
  const call = async (op: string, r: unknown) => {
    if (!op.startsWith('brep.')) throw new Error(`no mesh engine here (${op})`)
    return kernel.call(op.slice('brep.'.length), r)
  }
  expect(live()).toBe(0)
  let most = 0
  let canceled = 0
  for (let i = 0; i < 200; i++) {
    let steps = 0
    // every seventh replay is canceled before its second step after a warm start, as a newer edit would
    const yieldStep = async () => {
      if (i % 7 === 0 && ++steps === 2) throw Object.assign(new Error('Canceled'), { name: 'AbortError' })
    }
    try {
      const r = await replayHistory(call, { history: history(i), exact: true }, { keepsBodies: true, yieldStep })
      expect(r.status.every((s) => s.state === 'done')).toBe(true)
      expect(r.exactFellBack).toBeUndefined()
      expect(r.parts).toHaveLength(2)
    } catch (e) {
      expect((e as Error).name).toBe('AbortError')
      canceled++
    }
    most = Math.max(most, live())
  }
  // a replay with one step left to run finishes instead
  expect(canceled).toBeGreaterThan(20)
  // the cache holds a body per part per step, so the count stays bounded
  expect(most).toBeLessThan(2000)
  clearReplayCache()
  // a replay frees what the cache let go of
  await replayHistory(call, { history: { version: 1, base: [], steps: [] }, exact: true }, { keepsBodies: true })
  expect(live()).toBe(0)
}, 120_000)
