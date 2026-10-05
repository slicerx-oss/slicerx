// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { describeChange, makeBundle, mergeBundles, parseBundle } from '../src/presets/sync'
import type { UserPreset } from '../src/presets/store'

const p = (id: string, updatedAt: number, values: Record<string, number> = {}, name = id): UserPreset => ({ id, kind: 'process', name, values, createdAt: 1, updatedAt })
const empty = { presets: [] as UserPreset[], deleted: [], changes: [] }

describe('profile sync', () => {
  it('adds presets the other side has and keeps the ones only this side has', () => {
    const r = mergeBundles({ ...empty, presets: [p('a', 10)] }, makeBundle([p('b', 10)], [], []), 0, 100)
    expect(r.presets.map((x) => x.id)).toEqual(['a', 'b'])
    expect(r.applied.map((c) => `${c.action}:${c.id}`)).toEqual(['added:b'])
  })

  it('takes the newer edit and names the keys that changed', () => {
    const r = mergeBundles({ ...empty, presets: [p('a', 10, { wall_loops: 2 })] }, makeBundle([p('a', 20, { wall_loops: 4, infill: 15 })], [], []), 15, 100)
    expect(r.presets[0]!.values).toEqual({ wall_loops: 4, infill: 15 })
    expect(r.applied[0]).toMatchObject({ action: 'updated', keys: ['infill', 'wall_loops'] })
    expect(r.applied[0]!.conflict).toBeUndefined()
  })

  it('keeps the local copy when it is newer, and reports nothing', () => {
    const r = mergeBundles({ ...empty, presets: [p('a', 30, { wall_loops: 5 })] }, makeBundle([p('a', 20, { wall_loops: 4 })], [], []), 0, 100)
    expect(r.presets[0]!.values).toEqual({ wall_loops: 5 })
    expect(r.applied).toEqual([])
  })

  it('flags a preset edited on both sides since the last sync, and keeps the newer', () => {
    const r = mergeBundles({ ...empty, presets: [p('a', 40, { x: 1 })] }, makeBundle([p('a', 50, { x: 2 })], [], []), 30, 100)
    expect(r.presets[0]!.values).toEqual({ x: 2 })
    expect(r.applied[0]!.conflict).toBe(true)
    expect(describeChange(r.applied[0]!)).toContain('Edited on both sides')
  })

  it('a deletion beats an older copy, but not a newer edit', () => {
    const gone = mergeBundles({ ...empty, presets: [p('a', 10)] }, makeBundle([], [{ id: 'a', at: 20 }], []), 0, 100)
    expect(gone.presets).toEqual([])
    expect(gone.applied[0]!.action).toBe('removed')
    const kept = mergeBundles({ ...empty, presets: [p('a', 30)] }, makeBundle([], [{ id: 'a', at: 20 }], []), 0, 100)
    expect(kept.presets.map((x) => x.id)).toEqual(['a'])
    // The other direction: the remote still has it, the local side deleted it after.
    const localGone = mergeBundles({ ...empty, deleted: [{ id: 'a', at: 50 }] }, makeBundle([p('a', 10)], [], []), 0, 100)
    expect(localGone.presets).toEqual([])
    expect(localGone.applied).toEqual([])
  })

  it('does not depend on which side merges first', () => {
    const a = { ...empty, presets: [p('x', 10, { k: 1 }), p('y', 10)] }
    const b = makeBundle([p('x', 20, { k: 2 }), p('z', 5)], [{ id: 'y', at: 15 }], [])
    const one = mergeBundles(a, b, 0, 100)
    const two = mergeBundles({ presets: b.presets, deleted: b.deleted, changes: [] }, makeBundle(a.presets, [], []), 0, 100)
    expect(one.presets).toEqual(two.presets)
  })

  it('drops old tombstones and keeps the notes bounded', () => {
    const old = 100 - 91 * 86_400_000
    const r = mergeBundles({ ...empty, deleted: [{ id: 'old', at: old }] }, makeBundle([], [], []), 0, 100)
    expect(r.deleted).toEqual([])
  })

  it('reads a bundle and refuses anything else with a sentence', () => {
    const ok = parseBundle(JSON.stringify(makeBundle([p('a', 1)], [], [])))
    expect(ok.presets).toHaveLength(1)
    expect(() => parseBundle('nope')).toThrow('not a SlicerX sync file')
    expect(() => parseBundle(JSON.stringify({ format: 'slicerx-presets', version: 2 }))).toThrow('newer SlicerX')
    expect(parseBundle(JSON.stringify({ format: 'slicerx-presets', version: 1, presets: [{ id: 1 }, null] })).presets).toEqual([])
  })
})
