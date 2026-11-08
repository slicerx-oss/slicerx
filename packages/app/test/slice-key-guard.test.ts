// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The slice key cannot miss an input: every field of the app state is changed in turn, and any change to the
// configuration a plate slices with must change the plate's keys (sliceInputsKey and outputKey), which the app's stale
// checks and mimir's fingerprint read. A field outside INPUTS is caught as well as one inside it.
import { beforeAll, describe, expect, it } from 'vitest'
import { boxMesh } from '../src/plate/mesh-ops'
import { outputKey, sliceInputsKey } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { profileReady } from '../src/state/profile-sync'
import { plateSliceConfig } from '../src/state/slice-plate'
import { scriptNames } from '@slicerx/settings/script-keys'
import { get, set, type AppState, type PlateEntry } from '../src/state/store'

const handle = (id: string, slot: number) => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 10] as [number, number, number], openEdges: 0, parts: [{ name: 'Body', slot, triangles: 12 }] })
const part = (id: string, x: number, slot: number): PlateEntry => ({ id, name: id, handle: handle(id, slot), parts: [{ ...boxMesh(20, 20, 10), name: 'Body', slot }], colors: ['#ffffff'], transform: compose({ position: [x, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })

const config = (s: AppState): string => JSON.stringify(plateSliceConfig(s, s.plates.find((p) => p.id === s.activePlate)))
const keys = (s: AppState): string => `${sliceInputsKey(s)}|${outputKey(s)}`

/** A few changes to one value: a number moved, a flag flipped, text added, a list emptied, an object's fields changed. */
function variants(v: unknown, depth = 0): unknown[] {
  if (typeof v === 'number') return [v + 1, v * 2 + 3]
  if (typeof v === 'boolean') return [!v]
  if (typeof v === 'string') return [`${v}x`]
  if (Array.isArray(v)) return v.length ? [[], [...v, v[0]]] : []
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && depth < 2) {
    const out: unknown[] = []
    for (const [k, inner] of Object.entries(v as Record<string, unknown>).slice(0, 12)) for (const w of variants(inner, depth + 1)) out.push({ ...(v as object), [k]: w })
    return out
  }
  return []
}

/**
 * Changes no generic change makes: fields that start empty, another plate's part on a new slot and recolored objects.
 * projectScriptKeys (a value for a name the printer's G-code reads) and the recolor are added once the profile loads.
 */
const SEEDED: Partial<Record<keyof AppState, unknown[]>> = {
  printerNozzleVolume: [37, 120],
  // an opened project's flush volumes for the same two filaments
  projectFlush: [{ slots: [{ color: '#ffffff', type: 'PLA' }, { color: '#000000', type: 'PLA' }], n: 2, matrix: [0, 300, 300, 0], multiplier: 1 }],
  // another plate puts a part on slot 3: the shown plate's multi-color config lists slots up to 3
  plates: [[{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [part('c', 60, 3)], settings: {} }]],
}

beforeAll(async () => {
  set({ printerModel: { id: 'bench', vendor: 'Prusa', model: 'MK4' }, printerId: 'bench', printerSlots: [], slotSetup: { 1: { type: 'PLA', brand: 'Generic', color: '#ffffff' }, 2: { type: 'PLA', brand: 'Generic', color: '#000000' } }, layerMarks: {}, overrides: {}, objectSettings: {}, slice: { status: 'idle' }, autoSlice: false } as never)
  set({ plate: [part('a', 60, 1), part('b', 120, 2)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [part('c', 60, 1)], settings: {} }], activePlate: 'p1' })
  await profileReady()
  const cfg = plateSliceConfig(get(), get().plates[0]) as Record<string, unknown>
  const named = Object.entries(cfg).filter(([k, v]) => k.endsWith('_gcode') && typeof v === 'string').flatMap(([, v]) => [...scriptNames(v as string)])
  const name = named.find((n) => cfg[n] === undefined)
  if (name) SEEDED.projectScriptKeys = [{ [name]: '7' }]
  // the objects recolored: with no slot set up, a slot takes its filament color from the model
  SEEDED.plate = [get().plate.map((e) => ({ ...e, colors: ['#123456'] }))]
})

describe('the slice key', () => {
  it('changes with every change to the configuration a plate slices with', () => {
    const missed: string[] = []
    let tried = 0
    // with the slots set up by hand, and with none set up (the model's colors and the file's filaments fill them)
    for (const start of [{}, { slotSetup: {} }]) {
      const base = { ...get(), ...start } as AppState
      const before = config(base)
      const beforeKeys = keys(base)
      for (const field of Object.keys(base) as (keyof AppState)[]) {
        if (typeof base[field] === 'function') continue
        for (const v of [...variants(base[field]), ...(SEEDED[field] ?? [])]) {
          const s = { ...base, [field]: v } as AppState
          let after: string
          try {
            after = config(s)
          } catch {
            // a change the configuration cannot be built from is not a slice input
            continue
          }
          tried++
          if (after !== before && keys(s) === beforeKeys) missed.push(`${String(field)}: ${JSON.stringify(v)?.slice(0, 80)}`)
        }
      }
    }
    expect(SEEDED.projectScriptKeys).toBeDefined()
    expect(tried).toBeGreaterThan(100)
    expect(missed).toEqual([])
  })
})
