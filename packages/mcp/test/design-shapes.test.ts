// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part geom.build makes from one box or cylinder is saved tagged with that shape, as Add shape tags its parts, so
// an exact replay builds it as a true solid; the tag fits the triangles saved with it. The engine is a stand-in that
// makes the solids' meshes.
import { readFileSync } from 'node:fs'
import { fits, parseHistories, type PrimitiveSpec } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { readZip } from '../src/zip'
import { connect, data, text } from './helpers'

type V3 = [number, number, number]

function boxMesh(lo: V3, hi: V3) {
  const positions = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]])
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]
  return { positions, indices }
}

function cylinderMesh(o: V3, axis: V3, d: number, h: number, n = 32) {
  const l = Math.hypot(...axis)
  const a: V3 = [axis[0] / l, axis[1] / l, axis[2] / l]
  const s: V3 = Math.abs(a[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]
  const u: V3 = [s[1] * a[2] - s[2] * a[1], s[2] * a[0] - s[0] * a[2], s[0] * a[1] - s[1] * a[0]]
  const ul = Math.hypot(...u)
  u.forEach((_, k) => (u[k]! /= ul))
  const v: V3 = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]]
  const at = (r: number, t: number, z: number) => [0, 1, 2].map((k) => o[k]! + r * (Math.cos(t) * u[k]! + Math.sin(t) * v[k]!) + z * a[k]!)
  const positions = [...at(0, 0, 0), ...at(0, 0, h)]
  const indices: number[] = []
  for (let i = 0; i < n; i++) positions.push(...at(d / 2, (i / n) * 2 * Math.PI, 0), ...at(d / 2, (i / n) * 2 * Math.PI, h))
  for (let i = 0; i < n; i++) {
    const [b0, t0, b1, t1] = [2 + 2 * i, 3 + 2 * i, 2 + 2 * ((i + 1) % n), 3 + 2 * ((i + 1) % n)]
    indices.push(0, b1, b0, 1, t0, t1, b0, b1, t1, b0, t1, t0)
  }
  return { positions, indices }
}

const engine = async (op: string, request: unknown): Promise<unknown> => {
  const r = request as { solids: Record<string, unknown>[] }
  if (op !== 'build') throw new Error(`no stand-in for ${op}`)
  const s = r.solids[0]!
  return { mesh: s['type'] === 'box' ? boxMesh(s['min'] as V3, s['max'] as V3) : cylinderMesh(s['origin'] as V3, s['axis'] as V3, s['diameterMm'] as number, s['heightMm'] as number) }
}

describe('geom.build into a design', () => {
  it('tags a part made of one box or cylinder with its shape, and the tag fits the saved part', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: Record<string, unknown> }>(r).output
    }
    const d = (await ok('slicerx_design_new', { name: 'Shapes' }))['design'] as string
    await ok('slicerx_geom_build', { design: d, solids: [{ type: 'box', min: [0, 0, 0], max: [30, 20, 10] }], name: 'Block' })
    await ok('slicerx_geom_build', { design: d, solids: [{ type: 'cylinder', origin: [40, 0, 5], axis: [1, 0, 0], diameterMm: 8, heightMm: 12 }], name: 'Peg' })
    await ok('slicerx_geom_build', { design: d, solids: [{ type: 'box', min: [0, 0, 0], max: [5, 5, 5] }, { type: 'box', min: [4, 0, 0], max: [9, 5, 5] }], name: 'Two' })
    const saved = (await ok('slicerx_design_save', { design: d }))['path'] as string
    const zip = readZip(readFileSync(saved))
    const files = new Map(zip.names().map((n) => [n, new Uint8Array(zip.read(n)!)]))
    const ids = (JSON.parse(zip.text('Metadata/slicerx_history.json')!) as { objects: { object: string }[] }).objects.map((o) => o.object)
    const history = [...parseHistories(files, new Set(ids)).values()][0]!
    const added = history.steps.flatMap((s) => (s.params.op === 'parts.add' ? s.params.parts : []))
    expect(added.map((p) => p.name)).toEqual(['Block', 'Peg', 'Two'])
    const [block, peg, two] = added as [(typeof added)[0], (typeof added)[0], (typeof added)[0]]
    expect(block.primitive?.type).toBe('box')
    expect((block.primitive as PrimitiveSpec & { type: 'box' }).sizeMm).toEqual([30, 20, 10])
    expect(fits(block.primitive!, block.positions, block.indices)).toBe(true)
    expect(peg.primitive).toMatchObject({ type: 'cylinder', diameterMm: 8, heightMm: 12 })
    expect(peg.primitive!.frame.normal.map((x) => Math.round(x * 1e9) / 1e9 + 0)).toEqual([1, 0, 0])
    expect(fits(peg.primitive!, peg.positions, peg.indices)).toBe(true)
    // two solids joined are not one shape
    expect(two.primitive).toBeUndefined()
  })
})
