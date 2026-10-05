// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

import { describe, expect, it } from 'vitest'
import type { PrimeTowerPlacement } from '@slicerx/contracts'
import { towerMesh, towerNote, towerPlacement } from '../src/plate/tower'

const r = (reason: PrimeTowerPlacement['reason']): PrimeTowerPlacement => ({ x: 10, y: 20, width: 35, depth: 20, angle: 0, reason })

describe('prime tower', () => {
  it('says nothing while auto is on or the spot was kept', () => {
    expect(towerNote(r('moved_clear'), true)).toBeNull()
    expect(towerNote(r('kept'), false)).toBeNull()
  })
  it('explains a move or reshape of a hand placed tower without calling it an error', () => {
    expect(towerNote(r('moved_onto_bed'), false)).toMatch(/back onto the bed/)
    expect(towerNote(r('moved_clear'), false)).toMatch(/clear of the objects/)
    expect(towerNote(r('reshaped'), false)).toMatch(/wider and shallower/)
  })
  it('draws the reported spot with auto on and the typed corner with auto off', () => {
    const done = { status: 'done', stale: false, result: { primeTower: r('auto') } } as never
    expect(towerPlacement({ slice: done, tower: { auto: true, x: 0, y: 0 } })).toMatchObject({ x: 10, y: 20 })
    expect(towerPlacement({ slice: done, tower: { auto: false, x: 50, y: 60 } })).toMatchObject({ x: 50, y: 60, width: 35, reason: 'kept' })
    expect(towerPlacement({ slice: { status: 'idle' }, tower: { auto: true, x: 0, y: 0 } })).toBeNull()
  })
  it('builds a closed box whose transform is the front left corner', () => {
    const m = towerMesh({ ...r('auto'), angle: 90 }, 12)
    expect(m.positions).toHaveLength(24)
    expect(m.indices).toHaveLength(36)
    expect(m.transform.slice(12, 14)).toEqual([10, 20])
    expect(Math.abs(m.transform[0]!)).toBeLessThan(1e-9)
  })
})
