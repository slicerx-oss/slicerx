// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Parts Add shape makes carry the shape they are (MeshPart.primitive), so an exact replay can build them as true
// solids: the tag follows rigid moves and is dropped by any other, it only counts while the triangles still fit it,
// and it rides in the project file where older readers pass over it.
import type { MeshPart } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { fits, historyFiles, parseHistories, type History, type PrimitiveSpec } from '@slicerx/cad-history'
import { bake, primitive } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'

const placed = compose({ position: [128, 96, 0], rotation: [0, 0, 35], scale: [1, 1, 1] })
const ok = (p: MeshPart) => fits(p.primitive!, p.positions, p.indices)

describe('shape tags', () => {
  it('each shape fits its own triangles, here and moved onto the bed', () => {
    for (const s of ['box', 'cylinder', 'cone', 'sphere'] as const) {
      const p = primitive(s, 20)
      expect(p.primitive?.type).toBe(s)
      expect(ok(p), s).toBe(true)
      const moved = bake(p, placed)
      expect(moved.primitive?.frame.origin.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([128, 96, 0])
      expect(ok(moved), `${s} moved`).toBe(true)
    }
  })

  it('a box with one corner moved by 0.01 mm stays on the mesh', () => {
    const p = bake(primitive('box', 20), placed)
    const nudged = { ...p, positions: Float32Array.from(p.positions) }
    nudged.positions[3] = nudged.positions[3]! + 0.01
    expect(ok(p)).toBe(true)
    expect(ok(nudged)).toBe(false)
    // the tolerance goes with the part's size: on a 2 m box, 0.01 mm is within a hundred thousandth of it
    const big = primitive('box', 2000)
    const bigNudged = { ...big, positions: Float32Array.from(big.positions) }
    bigNudged.positions[3] = bigNudged.positions[3]! + 0.01
    expect(ok(bigNudged)).toBe(true)
  })

  it('a scale drops the tag, and the old tag does not fit the scaled part', () => {
    const p = primitive('cylinder', 20)
    const m = compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 1] })
    const stretched = bake(p, m)
    expect(stretched.primitive).toBeUndefined()
    expect(fits(p.primitive!, stretched.positions, stretched.indices)).toBe(false)
    // a mirror is rigid but turns the part inside out; it drops the tag too
    expect(bake(p, compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [-1, 1, 1] })).primitive).toBeUndefined()
  })
})

describe('shape tags in the project file', () => {
  const history = (base: MeshPart[]): History => ({ version: 1, base, steps: [] })
  const write = (h: History) => new Map(historyFiles([{ id: 'a', history: h }], new Map([['a', 7]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
  const read = (files: Map<string, Uint8Array>) => parseHistories(files, new Set(['7'])).get('7')

  it('a tagged part reads back with its tag', () => {
    const box = bake(primitive('box', 20), placed)
    const back = read(write(history([box, primitive('sphere', 10)])))!
    expect(back.base.map((p) => p.primitive?.type)).toEqual(['box', 'sphere'])
    expect(back.base[0]!.primitive).toEqual(box.primitive)
    expect(fits(back.base[0]!.primitive!, back.base[0]!.positions, back.base[0]!.indices)).toBe(true)
  })

  it('a tag this reader does not know is passed over and the part still opens', () => {
    const files = write(history([primitive('box', 20), primitive('cylinder', 20), primitive('cone', 20)]))
    const json = JSON.parse(new TextDecoder().decode(files.get('Metadata/slicerx_history.json'))) as { objects: { base: { parts: Record<string, unknown>[] } }[] }
    const parts = json.objects[0]!.base.parts
    parts[0]!['primitive'] = { type: 'torus', majorMm: 20, minorMm: 4, frame: (parts[0]!['primitive'] as PrimitiveSpec).frame }
    parts[1]!['primitive'] = 'cylinder'
    ;(parts[2]!['primitive'] as { frame: { u: number[] } }).frame.u = [2, 0, 0]
    files.set('Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify(json)))
    const back = read(files)!
    expect(back.base).toHaveLength(3)
    expect(back.base.every((p) => p.primitive === undefined)).toBe(true)
    expect(back.base[0]!.indices.length).toBe(36)
  })
})
