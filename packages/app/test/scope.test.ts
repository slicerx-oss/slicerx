// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { overrideCount, scopeOf, scopeValue, setScoped } from '../src/plate/scope'
import { get, set } from '../src/state/store'

const obj = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, parts: [{ name: 'body', slot: 1 }], ...extra }) as never
const PLATE = { wall_loops: 2, sparse_infill_density: '15%' }

beforeEach(() => {
  set({ plate: [obj('a'), obj('b'), obj('c'), obj('d', { instanceOf: 'a' })], objectSettings: {} })
})

describe('the scope a selection gives', () => {
  it('is the plate with nothing selected, the objects otherwise, and one part when the tree picks it', () => {
    expect(scopeOf([])).toEqual({ kind: 'plate' })
    expect(scopeOf(['a', 'b'])).toEqual({ kind: 'objects', ids: ['a', 'b'] })
    expect(scopeOf(['a'], { id: 'a', part: 'body' })).toEqual({ kind: 'part', id: 'a', part: 'body' })
    // A part of an object that is no longer the only one selected does not count.
    expect(scopeOf(['a', 'b'], { id: 'a', part: 'body' })).toEqual({ kind: 'objects', ids: ['a', 'b'] })
  })
})

describe('reading and writing a setting through a scope', () => {
  it('inherits the plate until an object has its own value', () => {
    expect(scopeValue(get(), PLATE, 'wall_loops', { kind: 'objects', ids: ['a'] })).toEqual({ value: 2, source: 'plate', plateValue: 2 })
    setScoped(get(), { kind: 'objects', ids: ['a'] }, 'wall_loops', 4)
    expect(scopeValue(get(), PLATE, 'wall_loops', { kind: 'objects', ids: ['a'] })).toEqual({ value: 4, source: 'own', plateValue: 2 })
    expect(scopeValue(get(), PLATE, 'wall_loops', { kind: 'plate' })).toEqual({ value: 2, source: 'plate', plateValue: 2 })
  })

  it('reads mixed when the selected objects differ, and an edit sets them all', () => {
    setScoped(get(), { kind: 'objects', ids: ['a'] }, 'wall_loops', 4)
    expect(scopeValue(get(), PLATE, 'wall_loops', { kind: 'objects', ids: ['a', 'b'] })).toEqual({ value: undefined, source: 'mixed', plateValue: 2 })
    setScoped(get(), { kind: 'objects', ids: ['a', 'b'] }, 'wall_loops', 3)
    expect(scopeValue(get(), PLATE, 'wall_loops', { kind: 'objects', ids: ['a', 'b'] })).toMatchObject({ value: 3, source: 'own' })
  })

  it('writes once per source, so an instance and its source share the value', () => {
    setScoped(get(), { kind: 'objects', ids: ['d'] }, 'wall_loops', 5)
    expect(get().objectSettings['a']).toEqual({ wall_loops: 5 })
    expect(scopeValue(get(), PLATE, 'wall_loops', { kind: 'objects', ids: ['a', 'd'] })).toMatchObject({ value: 5, source: 'own' })
  })

  it('resets one object without touching the others', () => {
    setScoped(get(), { kind: 'objects', ids: ['a', 'b'] }, 'wall_loops', 3)
    setScoped(get(), { kind: 'objects', ids: ['b'] }, 'wall_loops', undefined)
    expect(get().objectSettings['b']).toBeUndefined()
    expect(get().objectSettings['a']).toEqual({ wall_loops: 3 })
  })

  it('reads a part from its own value, then its object, then the plate', () => {
    const part = { kind: 'part', id: 'c', part: 'body' } as const
    expect(scopeValue(get(), PLATE, 'wall_loops', part)).toMatchObject({ value: 2, source: 'plate' })
    setScoped(get(), { kind: 'objects', ids: ['c'] }, 'wall_loops', 3)
    expect(scopeValue(get(), PLATE, 'wall_loops', part)).toMatchObject({ value: 3, source: 'own' })
    setScoped(get(), part, 'wall_loops', 6)
    expect(scopeValue(get(), PLATE, 'wall_loops', part)).toMatchObject({ value: 6, source: 'own' })
    expect(get().plate.find((p) => p.id === 'c')?.partSettings).toEqual({ body: { wall_loops: 6 } })
  })

  it('counts an object\'s own settings and its parts\' for the row badge', () => {
    setScoped(get(), { kind: 'objects', ids: ['c'] }, 'wall_loops', 3)
    setScoped(get(), { kind: 'part', id: 'c', part: 'body' }, 'sparse_infill_density', '40%')
    expect(overrideCount(get(), get().plate.find((p) => p.id === 'c')!)).toBe(2)
    expect(overrideCount(get(), get().plate.find((p) => p.id === 'b')!)).toBe(0)
  })
})
