// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Multiple plates, the Bambu Studio and OrcaSlicer way: every plate has its own objects and its own
// bed type, print sequence and filament order. The active plate's objects stay in `plate` so the
// rest of the app keeps working on one plate; the others wait in `plates`.
import { nozzleMapConfig } from '../filament/nozzle-map'
import { fullPlate, get, markStale, selectedIds, set, type AppState, type PlateEntry, type PlateMeta, type PlateSettings } from '../state/store'
import { quietly } from './history'
import { plateTower } from './tower'
import type { Mat4 } from './transform'

/** The plates with the active one's objects filled in. */
export function allPlates(s: Pick<AppState, 'plates' | 'plate' | 'activePlate'> & Partial<Pick<AppState, 'historyEdit'>> = get()): PlateMeta[] {
  // A history step open for editing shows an earlier mesh; saves write the object as it is.
  const objects = fullPlate({ plate: s.plate, historyEdit: s.historyEdit ?? null })
  return s.plates.map((p) => (p.id === s.activePlate ? { ...p, objects } : p))
}

export function activeMeta(s: Pick<AppState, 'plates' | 'activePlate'> = get()): PlateMeta | undefined {
  return s.plates.find((p) => p.id === s.activePlate)
}

function nextName(plates: readonly PlateMeta[]): string {
  let n = plates.length + 1
  while (plates.some((p) => p.name === `Plate ${n}`)) n++
  return `Plate ${n}`
}

let seq = 0
const newId = () => `plate-${Date.now().toString(36)}${(++seq).toString(36)}`

/** Shows another plate. Not an edit: undo does not step back through plate switches. */
export function switchPlate(id: string): void {
  const s = get()
  if (id === s.activePlate) return
  const target = s.plates.find((p) => p.id === id)
  if (!target) return
  quietly(() =>
    set({
      plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, objects: s.plate } : p.id === id ? { ...p, objects: [] } : p)),
      plate: target.objects,
      activePlate: id,
      // an opened project's tower stands at the shown plate's own spot
      tower: plateTower(s, id),
      selection: null,
      selectedIds: [],
      slice: { status: 'idle' },
      preview: null,
    }),
  )
}

/** Adds an empty plate after the others and shows it, or with `show` false leaves the shown plate as it is. Returns its id. */
export function addPlate(settings: PlateSettings = activeMeta()?.settings ?? {}, show = true): string {
  const s = get()
  const id = newId()
  set({ plates: [...s.plates, { id, name: nextName(s.plates), objects: [], settings: { ...settings } }] })
  if (show) switchPlate(id)
  return id
}

/**
 * Copies a plate with everything on it: objects at the same places, volumes, paint, part and object settings, instance
 * groups, and the plate's own sequence, bed type and filament order. The copy sits after the original and is shown.
 * One undo step takes it away. Returns the new plate's id, or null when the plate does not exist.
 */
export function duplicatePlate(id: string = get().activePlate): string | null {
  const s = get()
  const src = s.plates.find((p) => p.id === id)
  if (!src) return null
  const objects = id === s.activePlate ? s.plate : src.objects
  const ids = new Map(objects.map((o) => [o.id, `obj_${Date.now().toString(36)}c${(++seq).toString(36)}`]))
  const volId = () => `vol_${Date.now().toString(36)}c${(++seq).toString(36)}`
  const copies: PlateEntry[] = objects.map((o) => ({
    ...o,
    id: ids.get(o.id)!,
    transform: [...o.transform],
    ...(o.instanceOf ? { instanceOf: ids.get(o.instanceOf) ?? o.instanceOf } : {}),
    ...(o.volumes ? { volumes: o.volumes.map((v) => ({ ...v, id: volId() })) } : {}),
  }))
  const settings = { ...s.objectSettings }
  for (const [from, to] of ids) if (s.objectSettings[from]) settings[to] = { ...s.objectSettings[from]! }
  const copyId = newId()
  const name = `${src.name} copy`.slice(0, 40)
  const at = s.plates.findIndex((p) => p.id === id)
  const meta: PlateMeta = { id: copyId, name: s.plates.some((p) => p.name === name) ? nextName(s.plates) : name, objects: copies, settings: { ...src.settings } }
  const plates = [...s.plates.slice(0, at + 1), meta, ...s.plates.slice(at + 1)]
  set({ plates, objectSettings: settings })
  switchPlate(copyId)
  markStale()
  return copyId
}

/** Removes a plate with its objects. The last plate cannot go. */
export function removePlate(id: string): boolean {
  const s = get()
  if (s.plates.length <= 1) return false
  const i = s.plates.findIndex((p) => p.id === id)
  if (i < 0) return false
  if (id === s.activePlate) {
    const neighbor = s.plates[i + 1] ?? s.plates[i - 1]
    if (!neighbor) return false
    set({
      plates: s.plates.filter((p) => p.id !== id).map((p) => p.id === neighbor.id ? { ...p, objects: [] } : p),
      plate: neighbor.objects,
      activePlate: neighbor.id,
      selection: null,
      selectedIds: [],
      slice: { status: 'idle' },
      preview: null,
    })
  } else {
    set({ plates: s.plates.filter((p) => p.id !== id) })
  }
  markStale()
  return true
}

export function renamePlate(id: string, name: string): void {
  const n = name.trim().slice(0, 40)
  if (!n) return
  set((s) => ({ plates: s.plates.map((p) => (p.id === id ? { ...p, name: n } : p)) }))
}

/** Merges `patch` into a plate's settings, or with `replace` makes it the whole of them (to drop a key). */
export function setPlateSettings(id: string, patch: Partial<PlateSettings>, replace = false): void {
  set((s) => ({ plates: s.plates.map((p) => (p.id === id ? { ...p, settings: replace ? { ...patch } : { ...p.settings, ...patch } } : p)) }))
  if (id === get().activePlate) markStale()
}

/** One new plate's layout from arrange: where each of its objects goes, and with `order` (ids) the order they print in. */
export interface NewPlateLayout {
  transforms: Record<string, Mat4>
  order?: readonly string[]
}

/**
 * Moves objects of the shown plate that arrange found no room for to new plates after the others, one plate for each
 * layout, each with the shown plate's settings and its objects where the layout puts them (arrange lays them out with
 * the same nest as the shown plate, turns included). The shown plate stays shown. An object a layout names that is no
 * longer on the shown plate is skipped, and a layout left with none makes no plate. Returns the plates made with how
 * many went to each.
 */
export function moveToNewPlates(layouts: readonly NewPlateLayout[]): { id: string; name: string; count: number }[] {
  const made: { id: string; name: string; count: number }[] = []
  for (const layout of layouts) {
    const s = get()
    const ids = new Set(Object.keys(layout.transforms))
    const rank = new Map((layout.order ?? []).map((id, i) => [id, i]))
    const moving = s.plate.filter((p) => ids.has(p.id))
    if (moving.length === 0) continue
    const at = (p: PlateEntry) => rank.get(p.id) ?? rank.size + moving.indexOf(p)
    const placed = [...moving].sort((a, b) => at(a) - at(b)).map((m) => ({ ...m, transform: layout.transforms[m.id]! }))
    const id = addPlate(activeMeta()?.settings ?? {}, false)
    set({
      plate: get().plate.filter((p) => !ids.has(p.id)),
      plates: get().plates.map((p) => (p.id === id ? { ...p, objects: placed } : p)),
      selection: null,
      selectedIds: [],
    })
    markStale()
    made.push({ id, name: get().plates.find((p) => p.id === id)?.name ?? '', count: placed.length })
  }
  return made
}

/** The project's name for file names: its first object, without extension or odd characters. */
export function projectBase(objects?: readonly PlateEntry[]): string {
  const s = get()
  const first = objects?.[0]?.name ?? s.plate[0]?.name ?? s.plates.find((p) => p.objects.length)?.objects[0]?.name ?? 'project'
  return first.replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '_') || 'project'
}

/** What the slice request tells the engine for `filename_format`: the plate's name and number and the project's name. */
export function nameOptions(s: Pick<AppState, 'plates' | 'plate' | 'activePlate'> = get()): { plateName: string; plateNumber: number; modelName: string } {
  const i = Math.max(0, s.plates.findIndex((p) => p.id === s.activePlate))
  return { plateName: s.plates[i]?.name ?? `Plate ${i + 1}`, plateNumber: i + 1, modelName: projectBase() }
}

/**
 * Setting overrides a plate adds to the slice config: its own print sequence when it has one and, when the person
 * set one, its filament order (slots, 1-based) for the first layer and every other layer. Without an order the
 * engine picks the one with the least flush.
 */
export function plateConfig(meta: PlateMeta | undefined): Record<string, string | number | number[]> {
  if (!meta) return {}
  const seq = meta.settings.sequence
  const out: Record<string, string | number | number[]> = { ...(seq ? { print_sequence: seq === 'by-object' ? 'by object' : 'by layer' } : {}), ...nozzleMapConfig(meta) }
  const order = meta.settings.filamentOrder
  if (order && order.length > 1) {
    out['first_layer_print_sequence'] = [...order]
    // One block of [first layer, last layer, filaments...] that covers the whole print.
    out['other_layers_print_sequence'] = [1, 9999, ...order]
    out['other_layers_print_sequence_nums'] = 1
  }
  return out
}
