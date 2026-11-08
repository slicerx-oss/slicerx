// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The slice key cannot miss an input: every field of the app state is changed in turn, and any change to the
// configuration a plate slices with must change that plate's keys (sliceInputsKey and outputKey for the shown plate,
// plateInputsKey and its output key for a plate out of view), which the app's stale checks and mimir's fingerprint
// read. A field outside INPUTS is caught as well as one inside it. Every field must be changed at least once, or be
// named in NOT_TRIED with the reason, so a new field is never skipped unseen.
import { beforeAll, describe, expect, it } from 'vitest'
import { allPlates } from '../src/plate/all-plates'
import { boxMesh } from '../src/plate/mesh-ops'
import { outputKey, plateInputsKey, sliceInputsKey } from '../src/plate/resume-tops'
import { plateTower } from '../src/plate/tower'
import { compose } from '../src/plate/transform'
import { profileReady } from '../src/state/profile-sync'
import { plateSliceConfig } from '../src/state/slice-plate'
import { scriptNames } from '@slicerx/settings/script-keys'
import { get, set, type AppState, type PlateEntry } from '../src/state/store'

const handle = (id: string, slot: number) => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 10] as [number, number, number], openEdges: 0, parts: [{ name: 'Body', slot, triangles: 12 }] })
const part = (id: string, x: number, slot: number): PlateEntry => ({ id, name: id, handle: handle(id, slot), parts: [{ ...boxMesh(20, 20, 10), name: 'Body', slot }], colors: ['#ffffff'], transform: compose({ position: [x, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })

/** The shown plate p1, and p2 out of view as a plate switch would show it (plates.ts switchPlate). */
const shown = (s: AppState): AppState => s
const outOfView = (s: AppState): AppState => ({ ...s, plates: allPlates(s), activePlate: 'p2', plate: s.plates.find((p) => p.id === 'p2')?.objects ?? [], historyEdit: null, tower: plateTower(s, 'p2') })
const config = (view: AppState): string => JSON.stringify(plateSliceConfig(view, view.plates.find((p) => p.id === view.activePlate)))
const PLATES = [
  { name: 'the shown plate', view: shown, keys: (s: AppState) => `${sliceInputsKey(s)}|${outputKey(s)}` },
  { name: 'a plate out of view', view: outOfView, keys: (s: AppState) => `${plateInputsKey(s, 'p2')}|${outputKey(outOfView(s))}` },
]

/**
 * Changes to one value: a number moved, a flag flipped, text added, a list emptied, grown or its first entry changed,
 * an object's fields changed or a field added. An empty or missing value gets a value of each kind.
 */
function variants(v: unknown, depth = 0): unknown[] {
  if (v === null || v === undefined) return [1, 'x', true, { x: 1 }, ['x']]
  if (typeof v === 'number') return [v + 1, v * 2 + 3]
  if (typeof v === 'boolean') return [!v]
  if (typeof v === 'string') return [`${v}x`]
  if (typeof v !== 'object' || ArrayBuffer.isView(v) || v instanceof Map || v instanceof Set || depth > 3) return []
  if (Array.isArray(v)) {
    if (!v.length) return [['x'], [{ x: 1 }]]
    return [[], [...v, v[0]], ...variants(v[0], depth + 1).map((w) => [w, ...v.slice(1)])]
  }
  const out: unknown[] = [{ ...(v as object), x: 1 }]
  for (const [k, inner] of Object.entries(v as Record<string, unknown>).slice(0, 60)) for (const w of variants(inner, depth + 1)) out.push({ ...(v as object), [k]: w })
  return out
}

/**
 * Real changes for fields whose generic changes give the slice nothing to read. Each must change the shown plate's
 * configuration (checked below), and none may throw. projectScriptKeys and the recolor are added once the profile loads.
 */
const SEEDED: Partial<Record<keyof AppState, unknown[]>> = {
  printerNozzleVolume: [37, 120],
  // an opened project's flush volumes for the same two filaments
  projectFlush: [{ slots: [{ color: '#ffffff', type: 'PLA' }, { color: '#000000', type: 'PLA' }], n: 2, matrix: [0, 300, 300, 0], multiplier: 1 }],
  // another plate puts a part on slot 3: each plate's multi-color config lists slots up to 3
  plates: [[{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [part('c', 60, 3)], settings: {} }]],
  // a tool change to slot 3 on plate 2 does the same
  layerMarks: [{ p2: [{ id: 't1', z: 2, kind: 'tool_change', slot: 3 }] }],
  overrides: [{ layer_height: 0.12 }, { wall_loops: 5 }],
  printerSlots: [[{ id: '1', material: 'PETG', color: '#FF0000' }, { id: '2', material: 'PLA', color: '#000000' }]],
  flush: [{ multiplier: 1.5, manual: {} }],
  // a history step open for editing: the slice reads the object as it is, here on slot 3, not the rolled-back view
  historyEdit: [{ objectId: 'a', index: 0, original: part('a', 60, 3) }],
}

/** Fields no slice reads, and fields the slice reads but only where another check covers them, with the reason. */
const NOT_TRIED: Partial<Record<keyof AppState, string>> = {}

beforeAll(async () => {
  set({ printerModel: { id: 'bench', vendor: 'Prusa', model: 'MK4' }, printerId: 'bench', printerSlots: [], slotSetup: { 1: { type: 'PLA', brand: 'Generic', color: '#ffffff' }, 2: { type: 'PLA', brand: 'Generic', color: '#000000' } }, layerMarks: {}, overrides: {}, objectSettings: {}, slice: { status: 'idle' }, autoSlice: false } as never)
  set({ plate: [part('a', 60, 1), part('b', 120, 2)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [part('c', 60, 1), part('d', 120, 2)], settings: {} }], activePlate: 'p1' })
  await profileReady()
  const cfg = plateSliceConfig(get(), get().plates[0]) as Record<string, unknown>
  const named = Object.entries(cfg).filter(([k, v]) => k.endsWith('_gcode') && typeof v === 'string').flatMap(([, v]) => [...scriptNames(v as string)])
  const name = named.find((n) => cfg[n] === undefined)
  if (name) SEEDED.projectScriptKeys = [{ [name]: '7' }]
  // the objects recolored: with no slot set up, a slot takes its filament color from the model
  SEEDED.plate = [get().plate.map((e) => ({ ...e, colors: ['#123456'] }))]
})

describe('the slice key', () => {
  // with the slots set up by hand, with none set up (the model's colors and the file's filaments fill them), and with
  // every plate on one slot
  const ONE_SLOT = { plate: [part('a', 60, 1)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [part('c', 60, 1)], settings: {} }] }
  const STARTS = [{}, { slotSetup: {} }, ONE_SLOT]

  it('on plates of one slot, the nozzle volume and the flush matrix change neither the configuration nor the key', () => {
    // a single-color configuration has no flush volumes (slotConfig), so a new printer's nozzle volume keeps its slice
    const base = { ...get(), ...ONE_SLOT } as AppState
    for (const field of ['printerNozzleVolume', 'projectFlush'] as const)
      for (const v of SEEDED[field]!)
        for (const plate of PLATES) {
          const s = { ...base, [field]: v } as AppState
          expect(config(plate.view(s))).toBe(config(plate.view(base)))
          expect(plate.keys(s)).toBe(plate.keys(base))
        }
  })

  it('every seeded change changes the configuration of the shown plate', () => {
    expect(SEEDED.projectScriptKeys).toBeDefined()
    // a seed may change nothing in one start (a recolor under slots set up by hand), but must change it in some start
    const changes = new Map<string, number>()
    for (const start of STARTS) {
      const base = { ...get(), ...start } as AppState
      for (const [field, seeds] of Object.entries(SEEDED) as [keyof AppState, unknown[]][])
        for (const v of seeds) {
          const name = `${String(field)}: ${JSON.stringify(v)?.slice(0, 80)}`
          changes.set(name, (changes.get(name) ?? 0) + (config({ ...base, [field]: v } as AppState) === config(base) ? 0 : 1))
        }
    }
    expect([...changes].filter(([, n]) => n === 0).map(([name]) => name)).toEqual([])
  })

  for (const plate of PLATES)
    it(`changes with every change to the configuration ${plate.name} slices with`, () => {
      const missed: string[] = []
      const tried = new Map<string, number>()
      for (const start of STARTS) {
        const base = { ...get(), ...start } as AppState
        const before = config(plate.view(base))
        const beforeKeys = plate.keys(base)
        for (const field of Object.keys(base) as (keyof AppState)[]) {
          if (typeof base[field] === 'function') continue
          const seeds = SEEDED[field] ?? []
          for (const v of [...variants(base[field]), ...seeds]) {
            const s = { ...base, [field]: v } as AppState
            let after: string
            try {
              after = config(plate.view(s))
            } catch (e) {
              // a seeded change is a real state, so it never throws; a generic one may not be a state the app makes
              if (seeds.includes(v)) throw e
              continue
            }
            tried.set(field, (tried.get(field) ?? 0) + 1)
            if (after !== before && plate.keys(s) === beforeKeys) missed.push(`${String(field)}: ${JSON.stringify(v)?.slice(0, 80)}`)
          }
        }
      }
      // every field is changed at least once, or named with its reason
      const fields = Object.keys(get()).filter((k) => typeof get()[k as keyof AppState] !== 'function')
      expect(fields.filter((k) => !tried.get(k) && !(k in NOT_TRIED))).toEqual([])
      expect(missed).toEqual([])
    })
})
