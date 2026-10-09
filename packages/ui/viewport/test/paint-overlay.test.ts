// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The paint overlay is built in one pass into arrays of their final size. It must draw exactly what the earlier build
// drew: the painted leaf pieces in leavesOf order, their state's color, and the face normals computeVertexNormals gives.
import { BufferAttribute, BufferGeometry, Color, Group, Mesh } from 'three'
import { describe, expect, it } from 'vitest'
import { decodeTree, encodeTree, forEachPaintedLeaf, forEachPaintedLeafOfText, lazyPaintTexts, leavesOf, paintedLeafCount, paintTextLeafCount, readPaintTexts, trianglePoints, type PaintNode, type Tri } from '../src/paint'
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

  it('after an edit the overlay is still what the earlier build drew for the same paint', () => {
    const { e, mesh } = entry()
    const painter = new Painter(() => e, new Group(), () => {}, () => {}, () => CONTROL_PRESETS['orcaslicer'].gizmo.paint)
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00']
    painter.setColors(colors)
    painter.setData('o', 0, 'color', { 0: encodeTree(trees[0]!)! })
    // A tool's edit turns triangle 1 into a tree; triangle 0 stays as its text.
    painter.applyEdits('o', 0, 'color', [{ triangle: 1, text: encodeTree(trees[1]!) }])
    painter.sync()
    const g = (mesh.children[0] as Mesh).geometry
    const ref = reference(colors)
    expect(Array.from(g.getAttribute('position').array).sort()).toEqual(Array.from(new Float32Array(ref.pos)).sort())
    expect((g.getAttribute('color').array as Float32Array).length).toBe(ref.col.length)
  })
})

/** A random paint tree, some splits deep, with states 0 to 6 (4 and up take the extended code). */
function randomTree(rand: () => number, depth = 0): PaintNode {
  if (depth >= 5 || rand() < 0.45) return { state: Math.floor(rand() * 7) }
  const splits = (1 + Math.floor(rand() * 3)) as 1 | 2 | 3
  return { splits, special: Math.floor(rand() * 3) as 0 | 1 | 2, kids: Array.from({ length: splits + 1 }, () => randomTree(rand, depth + 1)) }
}

describe('paint texts read in place', () => {
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const tri: Tri = [[0, 0, 0], [12, 1, 0.5], [3, 9, 2]]

  it('walks the same pieces, corners and states as the decoded tree, for many random texts', () => {
    for (let i = 0; i < 400; i++) {
      const text = encodeTree(randomTree(rand))
      if (!text) continue
      const tree = decodeTree(text)!
      const want: number[] = []
      forEachPaintedLeaf(tri, tree, (v, st) => want.push(...v.flat(), st))
      const got: number[] = []
      const n = forEachPaintedLeafOfText(text, tri.flat(), (cs, at, st) => got.push(...cs.slice(at, at + 9), st))
      expect(got).toEqual(want)
      expect(n).toBe(paintedLeafCount(tree))
      expect(paintTextLeafCount(text)).toBe(paintedLeafCount(tree))
    }
  })

  it('refuses and keeps exactly the texts readPaintTexts does', () => {
    const texts: Record<number, string> = { 0: '', 1: 'G', 2: '  4 ', 3: '0', 4: '1', 5: '0C', 6: 'fz', 7: 'c', 8: '3', 9: encodeTree(trees[0]!)!, 10: '1000', 11: '\t8\n' }
    const lazy = lazyPaintTexts(texts)
    const eager = readPaintTexts(texts)
    expect(lazy.bad).toEqual(eager.bad)
    expect([...lazy.map.texts.keys()].sort()).toEqual([...eager.map.keys()].sort())
  })
})

describe('paint data round trip', () => {
  // Texts as a slicer writes them, one with lower case and spaces that a decode and encode would rewrite.
  const original: Record<number, string> = { 0: encodeTree(trees[0]!)!, 1: ' 8c ' }
  const painter = () => {
    const { e } = entry()
    return new Painter(() => e, new Group(), () => {}, () => {}, () => CONTROL_PRESETS['orcaslicer'].gizmo.paint)
  }

  it('an untouched part gives back its texts byte for byte', () => {
    const p = painter()
    p.setData('o', 0, 'color', original)
    p.sync()
    expect(p.getData('o', 0, 'color')).toEqual(original)
  })

  it('a part edited and then undone gives back its original texts', () => {
    const p = painter()
    p.setData('o', 0, 'color', { 0: original[0]! })
    // An edit, then the undo: the app hands the triangle's earlier text back.
    p.applyEdits('o', 0, 'color', [{ triangle: 0, text: encodeTree({ state: 2 }) }])
    expect(p.getData('o', 0, 'color')).toEqual({ 0: '8' })
    p.applyEdits('o', 0, 'color', [{ triangle: 0, text: original[0]! }])
    expect(p.getData('o', 0, 'color')).toEqual({ 0: original[0] })
  })
})
