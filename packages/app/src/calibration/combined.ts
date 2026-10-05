// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The new spool plate: flow pads, a pressure advance tower and a temperature tower on one plate, printed
// one object after another so each keeps its own settings (flow on the object, pressure advance and
// temperature by height on the tower). One print, three readings, saved for the spool, printer and nozzle.
import type { MeshHandle, MeshPart, SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/settings'
import { fromGeom, geom } from '../geom/client'
import { compose } from '../plate/transform'
import { addPlate } from '../plate/plates'
import { get, markStale, set, type CalibrationPart, type PlateEntry } from '../state/store'
import { calibCtx, calibEntryId, num1, type CalibResponse } from './actions'
import { calibTest, checkValues, type CalibId } from './tests'
import { brandAccent } from '../edition'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

/** The tests of the plate in print order: the temperature tower is the tallest, so it prints last and may stand above the gantry. */
export const COMBINED_TESTS: readonly CalibId[] = ['flow', 'pressure-advance', 'temp-tower']

export interface Footprint {
  id: string
  w: number
  h: number
}

/**
 * Places footprints in rows on the bed, every pair at least `gap` apart (the printer's extruder clearance, which a
 * by-object plate needs between objects). Returns each one's minimum corner, or null when they do not fit.
 */
export function packFootprints(items: Footprint[], bed: { widthMm: number; depthMm: number }, gap: number, margin = 5): Record<string, [number, number]> | null {
  const maxW = bed.widthMm - margin * 2
  const out: Record<string, [number, number]> = {}
  let x = 0
  let y = 0
  let rowH = 0
  for (const it of items) {
    if (it.w > maxW) return null
    if (x > 0 && x + it.w > maxW) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    out[it.id] = [x, y]
    x += it.w + gap
    rowH = Math.max(rowH, it.h)
  }
  const total = y + rowH
  if (total > bed.depthMm - margin * 2) return null
  // Center the block on the bed.
  const used = Math.max(...items.map((i) => out[i.id]![0] + i.w))
  const dx = margin + (maxW - used) / 2
  const dy = margin + (bed.depthMm - margin * 2 - total) / 2
  for (const it of items) out[it.id] = [out[it.id]![0] + dx, out[it.id]![1] + dy]
  return out
}

/** The values each test is built with: its defaults for this filament, and a pressure advance tower that stays under the gantry. */
export function combinedValues(defaults: (id: CalibId) => Record<string, number>): Record<string, Record<string, number>> {
  return Object.fromEntries(COMBINED_TESTS.map((id) => [id, defaults(id)]))
}

export async function addCombinedPlate(host: Loader, tests: readonly CalibId[], values: Record<string, Record<string, number>>, slot = 1): Promise<string> {
  const ids = COMBINED_TESTS.filter((t) => tests.includes(t))
  if (ids.length < 2) throw new Error('A combined plate needs at least two tests.')
  for (const id of ids) {
    const problem = checkValues(calibTest(id), values[id] ?? {})
    if (problem) throw new Error(`${calibTest(id).label}: ${problem}`)
  }
  const ctx = await calibCtx()
  const cfg = resolveConfig(get().easy, get().overrides) as Record<string, SettingValue | undefined>
  const radius = num1(cfg['extruder_clearance_radius'], 40)
  const rod = num1(cfg['extruder_clearance_height_to_rod'], 40)
  const bed = get().bed

  const parts: { id: CalibId; r: CalibResponse }[] = []
  for (const id of ids) {
    const test = calibTest(id)
    const request = test.request(values[id]!, ctx)
    // Everything but the last object must stand under the gantry: the pressure advance tower is capped to it.
    if (id === 'pressure-advance') {
      const height = Math.min(40, Math.floor(rod))
      if (height < 20) throw new Error(`The gantry clears only ${Math.floor(rod)} mm, too low for a pressure advance tower. Run that test on its own.`)
      request['heightMm'] = height
    }
    parts.push({ id, r: await geom().call<CalibResponse>('calibrate', { request, meshOutput: 'flat' }) })
  }

  // One footprint per object, laid out with the clearance between them.
  const flat: { id: CalibId; o: CalibResponse['objects'][number]; key: string; min: [number, number]; w: number; h: number }[] = []
  for (const { id, r } of parts) {
    r.objects.forEach((o, i) => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let k = 0; k < o.mesh.positions.length; k += 3) {
        minX = Math.min(minX, o.mesh.positions[k]!)
        maxX = Math.max(maxX, o.mesh.positions[k]!)
        minY = Math.min(minY, o.mesh.positions[k + 1]!)
        maxY = Math.max(maxY, o.mesh.positions[k + 1]!)
      }
      flat.push({ id, o, key: `${id}:${i}`, min: [minX, minY], w: maxX - minX, h: maxY - minY })
    })
  }
  const placed = packFootprints(flat.map((f) => ({ id: f.key, w: f.w, h: f.h })), bed, radius + 1)
  if (!placed) throw new Error(`These tests do not fit on this bed with ${Math.round(radius)} mm between objects. Run them one at a time.`)

  const entries: PlateEntry[] = []
  const objectSettings: Record<string, Record<string, SettingValue>> = {}
  const ofTest = new Map<CalibId, string[]>()
  for (const f of flat) {
    const part = fromGeom(f.o.mesh, f.o.name, slot)
    const handle = await host.loadParts(f.o.name, [part])
    const entryId = calibEntryId()
    const at = placed[f.key]!
    entries.push({ id: entryId, name: f.o.name, handle, parts: [part], colors: [brandAccent()], transform: compose({ position: [at[0] - f.min[0], at[1] - f.min[1], 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
    if (Object.keys(f.o.settings).length) objectSettings[entryId] = f.o.settings
    ofTest.set(f.id, [...(ofTest.get(f.id) ?? []), entryId])
  }

  const runParts: CalibrationPart[] = parts.map(({ id }) => ({ test: id, values: calibTest(id).candidates(values[id]!), params: { ...values[id]! } }))
  const ranges = parts.flatMap(({ id, r }) => r.ranges.map((range) => ({ ...range, objects: ofTest.get(id) ?? [] })))
  const instructions = parts.flatMap(({ id, r }) => [`${calibTest(id).label}.`, ...r.instructions])
  const plateId = addPlate()
  const first = runParts[0]!
  set((s) => ({
    plate: entries,
    selection: null,
    selectedIds: [],
    objectSettings: { ...s.objectSettings, ...objectSettings },
    plates: s.plates.map((p) => (p.id === plateId ? { ...p, name: 'Calibration: new spool', settings: { ...p.settings, sequence: 'by-object' as const } } : p)),
    calibration: { ...s.calibration, [plateId]: { test: first.test, slot, values: first.values, params: first.params, ranges, instructions, combined: runParts } },
  }))
  markStale()
  return plateId
}
