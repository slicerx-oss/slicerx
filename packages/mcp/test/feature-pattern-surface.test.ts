// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A row of cuts along a curved side follows the side: with onSurface each copy of a slit slides onto the side where it
// lands, so every slit is as deep as the first, where a plain row sinks deeper where the side swells and cuts nothing
// where it falls away. Neutral sample: a pod lofted along x through elliptical sections, wider in the middle.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

interface Summary {
  design: string
  volumeMm3: number
  steps: number
}

const geom = useGeomEngine('feature-pattern-surface-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

/**
 * The cosine and sine of 2 pi k / 24, as written when the engine replies were recorded. Math.cos and Math.sin can differ
 * in the last bit from one system to another, and a section built from them would then miss its recorded request.
 */
const COS24 = [1, 0.9659258262890683, 0.8660254037844387, 0.7071067811865476, 0.5000000000000001, 0.25881904510252074, 6.123233995736766e-17, -0.25881904510252063, -0.4999999999999998, -0.7071067811865475, -0.8660254037844387, -0.9659258262890682, -1, -0.9659258262890683, -0.8660254037844388, -0.7071067811865479, -0.5000000000000004, -0.25881904510252063, -1.8369701987210297e-16, 0.2588190451025203, 0.5000000000000001, 0.7071067811865474, 0.8660254037844384, 0.9659258262890681]
const SIN24 = [0, 0.25881904510252074, 0.49999999999999994, 0.7071067811865475, 0.8660254037844386, 0.9659258262890683, 1, 0.9659258262890683, 0.8660254037844387, 0.7071067811865476, 0.49999999999999994, 0.258819045102521, 1.2246467991473532e-16, -0.2588190451025208, -0.4999999999999997, -0.7071067811865471, -0.8660254037844385, -0.9659258262890683, -1, -0.9659258262890684, -0.8660254037844386, -0.7071067811865477, -0.5000000000000004, -0.25881904510252157]

/** An ellipse section across x at `x`, half width w, half height 8, centered 10 mm up. */
const section = (x: number, w: number) => ({
  frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  loops: [{ points: COS24.map((c, k) => [w * c, 10 + 8 * SIN24[k]!]) }],
})
// half widths 6, 12, 14, 12, 6 at x 0, 30, 60, 90, 120
const POD = [[0, 6], [30, 12], [60, 14], [90, 12], [120, 6]].map(([x, w]) => section(x!, w!))

async function client() {
  const h = await connect({ geomEngine: engine })
  const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: Summary }>(r).output
  }
  return { h, ok }
}

/** A pod with one slit 2 mm long, 3 mm tall and about 1 mm deep cut into its side at x 30, and the volume it took. */
async function slitPod() {
  const c = await client()
  const d = (await c.ok('slicerx_design_new', { name: 'Pod' })).design
  const pod = await c.ok('slicerx_geom_loft', { design: d, profiles: POD, name: 'Body' })
  const cut = await c.ok('slicerx_geom_subtract', { design: d, part: 0, feature: 'slit', solids: [{ type: 'box', min: [29, -13, 8.5], max: [31, -11, 11.5] }] })
  return { ...c, d, pod: pod.volumeMm3, one: pod.volumeMm3 - cut.volumeMm3 }
}


describe('the pod sections the replies were recorded for', () => {
  it('are the same numbers on every system: each table value within 1e-15 of Math, and the sections hash as recorded', () => {
    COS24.forEach((c, k) => expect(Math.abs(c - Math.cos((2 * Math.PI * k) / 24))).toBeLessThanOrEqual(1e-15))
    SIN24.forEach((v, k) => expect(Math.abs(v - Math.sin((2 * Math.PI * k) / 24))).toBeLessThanOrEqual(1e-15))
    expect(createHash('sha256').update(JSON.stringify(POD)).digest('hex')).toBe('6012fc244aa1f856856e47cb2b18cf27bca295f0ef8449e02a1c8cc7da9d3d85')
  })
})
describe('a row of cuts along a curved side', () => {
  it('keeps every slit as deep as the first when it follows the side', async () => {
    const { ok, d, pod, one } = await slitPod()
    expect(one).toBeGreaterThan(2)
    const row = await ok('slicerx_geom_array', { design: d, steps: ['slit'], spec: { kind: 'linear', count: 5, step: [15, 0, 0], onSurface: true } })
    const taken = pod - row.volumeMm3
    // five slits, each within a fifth of the first one's volume on average
    expect(taken / 5).toBeGreaterThan(one * 0.8)
    expect(taken / 5).toBeLessThan(one * 1.2)
  }, 60_000)

  it('sinks deeper where the side swells when the row does not follow it', async () => {
    const { ok, d, pod, one } = await slitPod()
    const row = await ok('slicerx_geom_array', { design: d, steps: ['slit'], spec: { kind: 'linear', count: 5, step: [15, 0, 0] } })
    expect((pod - row.volumeMm3) / 5).toBeGreaterThan(one * 1.3)
  }, 60_000)

  it('refuses a row whose every copy runs off the end of the body, and leaves the design as it was', async () => {
    const { h, d } = await slitPod()
    const r = await h.call('slicerx_geom_array', { design: d, steps: ['slit'], spec: { kind: 'linear', count: 3, step: [100, 0, 0], onSurface: true } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/None of the copies reach the part, so the pattern adds nothing/)
    const after = data<{ output: { steps: unknown[] } }>(await h.call('slicerx_design_steps', { design: d })).output
    expect(after.steps).toHaveLength(2)
  }, 60_000)

  it('follows a surface only on a row of steps', async () => {
    const { h, d } = await slitPod()
    const r = await h.call('slicerx_geom_array', { design: d, part: 0, spec: { kind: 'linear', count: 3, step: [15, 0, 0], onSurface: true } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/a row follows a surface when it repeats steps/)
  })
})
