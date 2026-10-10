// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { SETTINGS } from '../src/adapters/settings'
import { PLATE_WIDE, variesPerObject } from '../src/plate/plate-wide'
import { history } from '../src/plate/history'
import { overrideCount, scopeOf, scopeValue, setScoped, setScopedMany } from '../src/plate/scope'
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

describe('settings that hold for the whole plate', () => {
  it('names only process settings the schema has, and keeps print order, the prime tower and G-code output plate-wide', () => {
    const process = new Set(SETTINGS.filter((d) => d.section === 'process').map((d) => d.key))
    expect([...PLATE_WIDE].filter((k) => !process.has(k))).toEqual([])
    for (const k of ['print_sequence', 'enable_prime_tower', 'gcode_label_objects', 'travel_speed_z', 'outer_wall_acceleration']) expect(PLATE_WIDE.has(k)).toBe(true)
  })

  it('lets an object have its own walls, infill, layer height, supports and brim, but not the skirt, printer or filament settings', () => {
    const def = (key: string) => SETTINGS.find((d) => d.key === key)!
    for (const k of ['wall_loops', 'sparse_infill_density', 'layer_height', 'enable_support', 'brim_type', 'seam_position']) expect(variesPerObject(def(k))).toBe(true)
    for (const k of ['skirt_loops', 'spiral_mode', 'travel_speed']) expect(variesPerObject(def(k))).toBe(false)
    expect(variesPerObject(def('print_sequence'))).toBe(false)
    expect(variesPerObject(SETTINGS.find((d) => d.section === 'printer')!)).toBe(false)
    expect(variesPerObject(SETTINGS.find((d) => d.section === 'filament')!)).toBe(false)
  })

  it('lists every setting the engine is not seen reading outside its G-code writer', () => {
    // A key off the list must be read where the engine slices objects; one it reads only while writing the plate's
    // G-code, or not at all, cannot vary per object and belongs on the list.
    const writer = new Set(['gcode.rs', 'output.rs', 'cooling.rs', 'firmware.rs', 'customgcode.rs', 'motion.rs', 'preheat.rs', 'equalizer.rs', 'tower.rs', 'extras.rs', 'bgcode.rs', 'outname.rs', 'arcfit.rs', 'gcode_lint.rs'])
    const root = resolve(import.meta.dirname, '../../core/src')
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.rs') ? [join(dir, n)] : []))
    const read = files(root)
      .filter((f) => !writer.has(relative(root, f).split(sep)[0]!))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    const seen = (k: string) => read.includes(`"${k}"`) || new RegExp(`\\b${k}\\b`).test(read)
    const off = SETTINGS.filter((d) => d.section === 'process' && !PLATE_WIDE.has(d.key)).map((d) => d.key)
    expect(off.filter((k) => !seen(k))).toEqual([])
  })
})

describe('an Easy choice for a selection', () => {
  it('writes its keys on every target as one undo step', () => {
    const h = history()
    h.clear()
    setScopedMany(get(), { kind: 'objects', ids: ['a', 'b'] }, [['enable_support', true], ['support_type', 'tree(auto)']])
    expect(get().objectSettings['a']).toEqual({ enable_support: true, support_type: 'tree(auto)' })
    expect(get().objectSettings['b']).toEqual({ enable_support: true, support_type: 'tree(auto)' })
    h.undo()
    expect(get().objectSettings).toEqual({})
  })
})
