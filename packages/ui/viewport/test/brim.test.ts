// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { BrimEars } from '../src/brim'

describe('brim ears', () => {
  it('draws one disc per ear, in the alert color when flagged', () => {
    const b = new BrimEars()
    b.setEars({ a: [{ x: 10, y: 10, z: -0.0001, r: 4 }, { x: 30, y: 10, z: -0.0001, r: 4, error: true }] })
    expect(b.count).toBe(2)
    const [first, second] = b.group.children.filter((c) => c.type === 'Mesh' && c.visible !== false).slice(-2) as unknown as { material: { color: { r: number; g: number } } }[]
    expect(second?.material.color.r).toBeGreaterThan(first?.material.color.r ?? 1)
  })

  it('finds the ear under a point and ignores far points', () => {
    const b = new BrimEars()
    b.setEars({ a: [{ x: 10, y: 10, z: 0, r: 4 }], b: [{ x: 50, y: 50, z: 0, r: 2 }] })
    expect(b.hit(12, 11)).toEqual({ objectId: 'a', index: 0 })
    expect(b.hit(50.5, 50)).toEqual({ objectId: 'b', index: 0 })
    expect(b.hit(30, 30)).toBeNull()
    b.setEars({})
    expect(b.count).toBe(0)
    expect(b.hit(10, 10)).toBeNull()
  })

  it('tracks the selection from the selected flags', () => {
    const b = new BrimEars()
    b.setEars({ a: [{ x: 1, y: 1, z: 0, r: 3 }, { x: 9, y: 9, z: 0, r: 3, selected: true }] })
    expect(b.anySelected).toBe(true)
    expect(b.isSelected('a', 1)).toBe(true)
    expect(b.isSelected('a', 0)).toBe(false)
    b.setEars({ a: [{ x: 1, y: 1, z: 0, r: 3 }] })
    expect(b.anySelected).toBe(false)
  })

  it('shows the hover disc only with a radius and a position', () => {
    const b = new BrimEars()
    expect(b.setHover([5, 5])).toBe(false)
    b.setHoverRadius(3)
    expect(b.setHover([5, 5])).toBe(true)
    expect(b.setHover(null)).toBe(true)
  })
})
