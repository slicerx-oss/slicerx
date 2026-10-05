// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open project as mimir's skills see it (PilotProject): the plates and their objects, the
// resolved settings and the slice request, all read from the store at call time. Each change is
// one store update inside one undo step per tool call, and marks the slice stale like the panels do.
import type { Bed, Host, MeshPart, PilotMachine, Plate, PrintConfig, SettingValue, SliceWarning, SlicerHost } from '@slicerx/contracts'
import type { PilotProject, ProjectObject, ProjectPlate } from '@slicerx/pilot'
import { resolveSlots } from '../../filament/slots'
import { arrange } from '../../plate/arrange'
import { getArrangeOptions, sourceOf } from '../../plate/edit'
import { inStep } from '../../plate/history'
import { allPlates, projectBase } from '../../plate/plates'
import { bounds, centerOnBed, decompose, dropToBed, identity, sizeOf, withTrs, type Mat4, type Vec3 } from '../../plate/transform'
import { GCODE_TEXT_KEYS, plateObjects, plateSliceConfig, trustOptions } from '../../state/actions'
import { get, markStale, set, toast, type AppState, type PlateEntry, type PlateMeta } from '../../state/store'

const round = (v: number): number => Math.round(v * 100) / 100

function sizeMm(e: PlateEntry): [number, number, number] {
  const b = bounds(e.parts, e.transform)
  return b ? (sizeOf(b).map(round) as [number, number, number]) : [0, 0, 0]
}

function rotationOf(e: PlateEntry): [number, number, number] | undefined {
  const r = decompose(e.transform).rotation
  return r.some((d) => Math.abs(d) > 1e-6) ? (r.map(round) as [number, number, number]) : undefined
}

/** Rotates about the object's center in X and Y and sets it back down on the bed. */
function rotated(e: PlateEntry, rotate: Vec3): Mat4 {
  const before = bounds(e.parts, e.transform)
  const turned = dropToBed(e.parts, withTrs(e.transform, { rotation: rotate }))
  const after = bounds(e.parts, turned)
  if (!before || !after) return turned
  const out = [...turned]
  out[12] = (out[12] ?? 0) + (before.min[0] + before.max[0] - after.min[0] - after.max[0]) / 2
  out[13] = (out[13] ?? 0) + (before.min[1] + before.max[1] - after.min[1] - after.max[1]) / 2
  return out
}

function toObject(e: PlateEntry): ProjectObject {
  const triangles = e.parts.reduce((n, p) => n + p.indices.length / 3, 0)
  return { id: e.id, name: e.name, bboxMm: sizeMm(e), triangles, mesh: async (): Promise<MeshPart[]> => e.parts }
}

/** Where an object lives: the plate and its entries. */
function find(objectId: string): { meta: PlateMeta; index: number; entry: PlateEntry } | null {
  const plates = allPlates(get())
  for (let i = 0; i < plates.length; i++) {
    const entry = plates[i]!.objects.find((o) => o.id === objectId)
    if (entry) return { meta: plates[i]!, index: i + 1, entry }
  }
  return null
}

let seq = 0
const uid = (base: string): string => `${base}~${Date.now().toString(36)}m${(++seq).toString(36)}`

/** Squares copies to the bed, as new copies from the object list are. */
const placeOptions = () => ({ ...getArrangeOptions(), rotate: false })

/** An object's family across plates: the object itself, its copies, and the objects mimir made from it on other plates. */
const familyOf = (o: Pick<PlateEntry, 'id' | 'instanceOf'>): string => sourceOf(o as PlateEntry).replace(/~p\d+$/, '')

/** The plates with the shown one's objects filled in, ready to change and write back in one store update. */
function draft(): PlateMeta[] {
  return allPlates(get()).map((p) => ({ ...p, objects: [...p.objects] }))
}

/** Writes plates back in one store update: one undo step. The shown plate stays shown when it still exists. */
function commit(plates: PlateMeta[], extra: Partial<AppState> = {}): void {
  const s = get()
  const active = plates.find((p) => p.id === s.activePlate) ?? plates[0]!
  set({ plate: active.objects, plates: plates.map((p) => (p.id === active.id ? { ...p, objects: [] } : p)), activePlate: active.id, ...extra })
  markStale()
}

/** Sets how many of a family stand on a plate, newest copies going first and new ones placed in free space. */
function setCount(plate: PlateMeta, family: string, count: number, from: PlateEntry | undefined, index: number, bed: Bed): number {
  const mine = plate.objects.filter((o) => familyOf(o) === family)
  if (count === mine.length) return 0
  if (count < mine.length) {
    // Instances go before the object they copy.
    const drop = new Set([...mine.filter((o) => o.instanceOf), ...mine.filter((o) => !o.instanceOf)].slice(0, mine.length - count).map((o) => o.id))
    plate.objects = plate.objects.filter((o) => !drop.has(o.id))
    return 0
  }
  const root = mine.find((o) => !o.instanceOf)
  let base = root ?? mine[0] ?? from
  if (!base) return 0
  const fresh: PlateEntry[] = []
  if (!root) {
    // The first one on another plate is an object of its own there.
    const { instanceOf: _was, ...own } = base
    base = { ...own, id: `${family}~p${index}`, transform: [...base.transform] }
    fresh.push(base)
  }
  const rootId = base.id
  while (mine.length + fresh.length < count) fresh.push({ ...base, id: uid(rootId), instanceOf: rootId, transform: [...base.transform] })
  const r = arrange(fresh, plate.objects, bed, placeOptions())
  const placed = fresh.filter((c) => r.transforms[c.id]).map((c) => ({ ...c, transform: r.transforms[c.id]! }))
  plate.objects = [...plate.objects, ...placed]
  return fresh.length - placed.length
}

function newPlate(plates: readonly PlateMeta[], settings: PlateMeta['settings']): PlateMeta {
  let n = plates.length + 1
  while (plates.some((p) => p.name === `Plate ${n}`)) n++
  return { id: `plate-${Date.now().toString(36)}m${(++seq).toString(36)}`, name: `Plate ${n}`, objects: [], settings: { ...settings } }
}

/**
 * The open project for mimir. Each tool call gets its own view, and every change a call makes is one undo step, so one
 * Ctrl+Z takes back one assistant action.
 */
export function appProject(host: Pick<Host, 'slicer'>): () => PilotProject {
  // Printers mimir assigned plates to, by plate id. The app itself sends the shown plate to the chosen printer.
  const printers = new Map<string, string>()
  const metaAt = (plateIndex: number): PlateMeta | undefined => allPlates(get())[plateIndex - 1]
  return () => {
    const token = {}
    const edit = <T>(fn: () => T): T => inStep(token, fn)
    return {
      get name() {
        return projectBase()
      },
      machine(): PilotMachine | undefined {
        const s = get()
        if (!s.printerModel) return undefined
        const slot = resolveSlots(s)[0]
        return { printer: `${s.printerModel.vendor} ${s.printerModel.model}`.trim(), material: slot?.family || slot?.type || 'PLA', nozzle: s.profile?.nozzle ?? 0.4 }
      },
      objects() {
        return allPlates(get()).flatMap((p) => p.objects.filter((o) => !o.instanceOf).map(toObject))
      },
      plates(): ProjectPlate[] {
        const s = get()
        return allPlates(s).map((p, i) => {
          const items: ProjectPlate['items'] = []
          for (const o of p.objects) {
            if (o.instanceOf) continue
            const rotate = rotationOf(o)
            items.push({ objectId: o.id, copies: p.objects.filter((x) => sourceOf(x) === o.id).length, ...(rotate ? { rotate } : {}) })
          }
          const printerId = printers.get(p.id) ?? (p.id === s.activePlate ? (s.printerId ?? undefined) : undefined)
          return { index: i + 1, ...(printerId ? { printerId } : {}), items }
        })
      },
      /**
       * Lays out the objects `next` names: their copies on each plate, new plates as needed, and none on plates `next`
       * leaves out. Plates this empties go. Objects `next` does not name stay where they are.
       */
      setPlates(next: ProjectPlate[]): void {
        const s = get()
        const plates = draft()
        const before = new Set(plates.filter((p) => p.objects.length).map((p) => p.id))
        const all = plates.flatMap((p) => p.objects)
        const families = new Set(next.flatMap((p) => p.items.map((i) => familyOf(all.find((o) => o.id === i.objectId) ?? { id: i.objectId }))))
        const settings = plates.find((p) => p.id === s.activePlate)?.settings ?? {}
        while (plates.length < Math.max(0, ...next.map((p) => p.index))) plates.push(newPlate(plates, settings))
        let left = 0
        plates.forEach((plate, i) => {
          const target = next.find((p) => p.index === i + 1)
          if (target?.printerId) printers.set(plate.id, target.printerId)
          for (const family of families) {
            const count = target?.items.filter((it) => familyOf(all.find((o) => o.id === it.objectId) ?? { id: it.objectId }) === family).reduce((n, it) => n + Math.max(0, it.copies), 0) ?? 0
            left += setCount(plate, family, count, all.find((o) => familyOf(o) === family && !o.instanceOf), i + 1, s.bed)
          }
        })
        const kept = plates.filter((p) => p.objects.length || !before.has(p.id))
        for (const p of plates) if (!kept.includes(p)) printers.delete(p.id)
        if (left) toast(`${left} ${left === 1 ? 'copy' : 'copies'} did not fit and ${left === 1 ? 'was' : 'were'} left off.`, 'warn')
        edit(() => commit(kept.length ? kept : plates.slice(0, 1)))
      },
      overrides() {
        return { ...get().overrides }
      },
      setOverrides(changes: Record<string, SettingValue>): void {
        // Supports for the whole plate are the Supports control, so it shows what mimir set.
        const { enable_support: supports, ...rest } = changes
        edit(() => {
          if (typeof supports === 'boolean') set((s) => ({ easy: { ...s.easy, supports: supports ? 'auto' : 'off' }, easyTouched: [...new Set([...s.easyTouched, 'supports'])] }))
          if (Object.keys(rest).length) set((s) => ({ overrides: { ...s.overrides, ...rest }, goal: 'custom' as const }))
          markStale()
        })
      },
      config(plateIndex: number): PrintConfig {
        return plateSliceConfig(get(), metaAt(plateIndex))
      },
      async plate(plateIndex: number): Promise<Plate> {
        const meta = metaAt(plateIndex)
        if (!meta) throw new Error(`No plate ${plateIndex}`)
        const s = get()
        return { bed: s.bed, objects: await plateObjects(host.slicer, s, meta, meta.objects) }
      },
      setRotation(objectId: string, rotate: [number, number, number]): void {
        if (!find(objectId)) throw new Error(`No object ${objectId}`)
        const plates = draft()
        for (const p of plates) p.objects = p.objects.map((o) => (sourceOf(o) === objectId && !o.locked ? { ...o, transform: rotated(o, rotate) } : o))
        edit(() => commit(plates))
      },
      /** A made object goes in free space on the shown plate, or on a new plate when it has no room. */
      async addObject(obj: ProjectObject, parts: MeshPart[]): Promise<void> {
        const handle = await host.slicer.loadParts(obj.name, parts)
        const s = get()
        const id = find(obj.id) ? uid(obj.id) : obj.id
        const entry: PlateEntry = { id, name: obj.name, handle, parts, colors: resolveSlots(s).map((x) => x.color), transform: dropToBed(parts, centerOnBed(parts, identity(), s.bed)) }
        const plates = draft()
        const shown = plates.find((p) => p.id === s.activePlate)!
        const t = arrange([entry], shown.objects, s.bed, placeOptions()).transforms[id]
        let extra: Partial<AppState> = { selection: id, selectedIds: [id] }
        if (t) shown.objects = [...shown.objects, { ...entry, transform: t }]
        else {
          const p = newPlate(plates, shown.settings)
          p.objects = [entry]
          plates.push(p)
          extra = { ...extra, activePlate: p.id }
        }
        edit(() => {
          if (extra.activePlate) set({ activePlate: extra.activePlate })
          commit(plates, extra)
        })
      },
      /**
       * Swaps objects for others. A replacement with the id of an object it replaces takes its place and copies (a
       * repaired or hollowed mesh); new ones (cut parts) go where the first replaced object was, in free space around it,
       * with its settings.
       */
      async replaceObjects(ids: string[], replacements: ProjectObject[]): Promise<void> {
        const first = ids.map(find).find(Boolean)
        if (!first) throw new Error(`No object ${ids[0] ?? ''}`)
        const loaded = await Promise.all(
          replacements.map(async (r) => {
            const parts = r.mesh ? await r.mesh() : []
            if (!parts.length) throw new Error(`No geometry for ${r.name}, so the plate was not changed`)
            return { r, parts, handle: await host.slicer.loadParts(r.name, parts) }
          }),
        )
        const s = get()
        const gone = new Set(ids)
        const plates = draft()
        const home = plates.find((p) => p.id === first.meta.id)!
        const settings = { ...s.objectSettings }
        const fresh: PlateEntry[] = []
        for (const { r, parts, handle } of loaded) {
          if (gone.has(r.id)) {
            // In place: the object and its copies keep where they stand.
            gone.delete(r.id)
            for (const p of plates) p.objects = p.objects.map((o) => (sourceOf(o) === r.id ? { ...o, name: r.name, handle, parts, transform: dropToBed(parts, o.transform) } : o))
            continue
          }
          const { instanceOf: _was, history: _h, ...base } = first.entry
          fresh.push({ ...base, id: find(r.id) ? uid(r.id) : r.id, name: r.name, handle, parts, transform: dropToBed(parts, first.entry.transform) })
          if (s.objectSettings[first.entry.id]) settings[fresh.at(-1)!.id] = { ...s.objectSettings[first.entry.id]! }
        }
        for (const p of plates) p.objects = p.objects.filter((o) => !gone.has(sourceOf(o)))
        for (const id of gone) delete settings[id]
        if (fresh.length) {
          const r = arrange(fresh, home.objects, s.bed, placeOptions())
          home.objects = [...home.objects, ...fresh.map((f) => (r.transforms[f.id] ? { ...f, transform: r.transforms[f.id]! } : f))]
        }
        edit(() => commit(plates, { objectSettings: settings, selection: null, selectedIds: [] }))
      },
      async warnings(plateIndex: number): Promise<SliceWarning[] | null> {
        const s = get()
        if (metaAt(plateIndex)?.id !== s.activePlate || s.slice.status !== 'done' || s.slice.stale) return null
        return [...s.slice.result.warnings]
      },
    }
  }
}

/**
 * The slicer mimir's skills call. A request whose G-code settings are the ones the shown plate would slice with (the
 * text shipped for the printer, with nothing overridden) gets the same trust and machine limits as the Slice button;
 * any other request gets the strict checks.
 */
export function pilotSlicer(host: Pick<Host, 'slicer'>): SlicerHost {
  const base = host.slicer
  const slice: SlicerHost['slice'] = (req, opts) => {
    const s = get()
    const trust = trustOptions(s)
    const mine: Record<string, unknown> = plateSliceConfig(s, allPlates(s).find((p) => p.id === s.activePlate))
    const asked: Record<string, unknown> = req.config
    const same = [...(s.profile?.gcodeKeys ?? []), ...GCODE_TEXT_KEYS].every((k) => JSON.stringify(asked[k]) === JSON.stringify(mine[k]))
    // Trust is the app's to give, never the caller's.
    const { trustedGcode: _asked, ...options } = req.options ?? {}
    const extra = same ? trust : trust.machineLimits ? { machineLimits: trust.machineLimits } : {}
    return base.slice({ ...req, options: { ...options, ...extra } }, opts)
  }
  return new Proxy(base, {
    get(target, key) {
      if (key === 'slice') return slice
      const v: unknown = Reflect.get(target, key)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
