// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { Matrix4, Vector3 } from 'three'
import { GapLines } from '../src/gaps'

const at = (x: number, y: number) => new Matrix4().makeTranslation(x, y, 0)
const ends = (g: GapLines) => {
  g.group.updateMatrixWorld(true)
  return g.group.children.map((c) => (c.children[1] ? c.children[1].getWorldPosition(new Vector3()).toArray().map((v) => Math.round(v * 100) / 100) : null))
}

describe('fit gap lines', () => {
  it('follow the object they were measured on, the moment it moves', () => {
    const g = new GapLines()
    g.set([{ from: [10, 10, 5], to: [10.1, 10, 5], kind: 'horizontal', on: [{ id: 'a', transform: at(0, 0).toArray() }] }])
    const m = at(0, 0)
    g.follow(() => m)
    expect(ends(g)).toEqual([[10, 10, 5]])
    m.copy(at(30, -5))
    g.follow(() => m)
    expect(ends(g)).toEqual([[40, 5, 5]])
    expect(g.group.children[0]!.visible).toBe(true)
  })

  it('hide a line between two objects once either moves, and drop lines whose object is gone', () => {
    const g = new GapLines()
    g.set([
      { from: [0, 0, 0], to: [0, 0, 0], kind: 'fused', on: [{ id: 'a', transform: at(0, 0).toArray() }, { id: 'b', transform: at(20, 0).toArray() }] },
      { from: [0, 0, 0], to: [1, 0, 0], kind: 'vertical', on: [{ id: 'c', transform: at(0, 0).toArray() }] },
    ])
    const where: Record<string, Matrix4> = { a: at(0, 0), b: at(20, 0) }
    g.follow((id) => where[id])
    expect(g.group.children.map((c) => c.visible)).toEqual([true, false])
    where['b'] = at(25, 0)
    g.follow((id) => where[id])
    expect(g.group.children[0]!.visible).toBe(false)
  })

  it('leaves a line measured on nothing where it is', () => {
    const g = new GapLines()
    g.set([{ from: [1, 2, 3], to: [1, 2, 4], kind: 'vertical' }])
    g.follow(() => undefined)
    expect(g.group.children[0]!.visible).toBe(true)
    expect(ends(g)).toEqual([[1, 2, 3]])
  })
})
