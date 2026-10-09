// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The paint overlay is built in one pass into arrays of their final size. It must draw exactly what the earlier build
// drew: the painted leaf pieces in leavesOf order, their state's color, and the face normals computeVertexNormals gives.
import { BufferAttribute, BufferGeometry, Color, Group, Mesh } from 'three'
import { describe, expect, it } from 'vitest'
import { encodeTree, leavesOf, paintedLeafCount, trianglePoints, type PaintNode } from '../src/paint'
import { Painter } from '../src/painter'
import { CONTROL_PRESETS } from '../src/controls'
import type { ObjectEntry } from '../src/model'

// Two triangles, the second tilted, so normals differ.
const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10, 3, 0, 10, 0])
const indices = new Uint32Array([0, 1, 2, 1, 4, 5])
const leaf = (state: number): PaintNode => ({ state })
const trees: PaintNode[] = [
  { splits: 3, special: 0, kids: [leaf(1), leaf(0), { splits: 1, special: 2, kids: [leaf(2), leaf(3)] }, leaf(2)] },
  { splits: 2, special: 1, kids: [leaf(0), leaf(1), leaf(4)] },
]

function entry(): { e: ObjectEntry; mesh: Mesh } {
  const mesh = new Mesh(new BufferGeometry())
  mesh.userData.source = { positions, indices }
  const group = new Group()
  group.add(mesh)
  return { e: { id: 'o', name: 'o', group, parts: [{ mesh } as unknown as ObjectEntry['parts'][number]] }, mesh }
}

/** The overlay as the earlier build made it. */
function reference(colors: readonly string[]): { pos: number[]; col: number[]; nor: Float32Array } {
  const pos: number[] = []
  const col: number[] = []
  trees.forEach((node, t) => {
    for (const l of leavesOf(trianglePoints(positions, indices, t), node)) {
      if (l.state === 0) continue
      const c = new Color(colors[l.state - 1])
      for (const v of l.v) pos.push(...v), col.push(c.r, c.g, c.b)
    }
  })
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.computeVertexNormals()
  return { pos, col, nor: g.getAttribute('normal').array as Float32Array }
}

describe('paint overlay', () => {
  it('draws the same pieces, colors and normals as before, in arrays of their final size', () => {
    const { e, mesh } = entry()
    const painter = new Painter((id) => (id === 'o' ? e : undefined), new Group(), () => {}, () => {}, () => CONTROL_PRESETS['orcaslicer'].gizmo.paint)
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00']
    painter.setColors(colors)
    painter.setData('o', 0, 'color', Object.fromEntries(trees.map((n, t) => [t, encodeTree(n)!])))
    painter.sync()
    const overlay = mesh.children[0] as Mesh
    const g = overlay.geometry
    const ref = reference(colors)
    const n = trees.reduce((s, t) => s + paintedLeafCount(t), 0)
    expect(n).toBe(6)
    expect((g.getAttribute('position').array as Float32Array).length).toBe(9 * n)
    expect(Array.from(g.getAttribute('position').array)).toEqual(Array.from(new Float32Array(ref.pos)))
    expect(Array.from(g.getAttribute('color').array)).toEqual(Array.from(new Float32Array(ref.col)))
    const nor = g.getAttribute('normal').array as Float32Array
    expect(nor.length).toBe(ref.nor.length)
    expect(Array.from(nor)).toEqual(Array.from(ref.nor))
  })

  it('draws nothing for a part whose pieces are all unpainted', () => {
    const { e, mesh } = entry()
    const painter = new Painter(() => e, new Group(), () => {}, () => {}, () => CONTROL_PRESETS['orcaslicer'].gizmo.paint)
    painter.setData('o', 0, 'color', { 0: encodeTree({ splits: 1, special: 0, kids: [leaf(0), leaf(0)] })! })
    painter.sync()
    expect(mesh.children).toHaveLength(0)
  })
})
