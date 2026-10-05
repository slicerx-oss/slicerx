// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opens an STL, OBJ, AMF or STEP through the geometry engine's automatic import: every mesh is
// repaired, the unit is detected (inch or meter files are scaled to millimeters, with a toast that
// undoes it) and a file with several loose bodies becomes several objects. Meshes arrive unscaled; the
// scale is the object's transform, so undoing it is one edit. A STEP file is meshed first in a worker
// of its own (import-step.ts) and arrives in millimeters, since STEP declares its unit.
import type { Bed, Host, MeshPart } from '@slicerx/contracts'
import { fromGeom, type GeomMesh } from '../geom/client'
import type { AutoImport, Unit } from '../geom/cad'
import type { StepConverter } from './import-step'
import { centerOnBed, compose, dropToBed, setScale } from '../plate/transform'
import { repairChanged, rememberRepair, showRepairReport, type RepairEntry } from '../plate/repair-report'
import { get, markStale, set, toast, type PlateEntry } from './store'
import { brandAccent, objectPalette } from '../edition'

export type AutoFormat = 'stl' | 'obj' | 'amf' | 'step'
type MeshFormat = Exclude<AutoFormat, 'step'>

/** File names the automatic import opens. */
export const AUTO_FILE = /\.(stl|obj|amf|step|stp)$/i

export function autoFormatOf(name: string): AutoFormat | null {
  const m = AUTO_FILE.exec(name)
  if (!m) return null
  const ext = m[1]!.toLowerCase()
  return ext === 'stp' ? 'step' : (ext as AutoFormat)
}

export function toBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

let seq = 0
const uid = () => `obj_${Date.now().toString(36)}a${(++seq).toString(36)}`

export type AutoRunner = (file: { base64: string; name: string; format: MeshFormat; declaredUnit?: Unit }) => Promise<AutoImport>

async function engine({ declaredUnit, ...file }: { base64: string; name: string; format: MeshFormat; declaredUnit?: Unit }): Promise<AutoImport> {
  const { importAuto } = await import('../geom/cad')
  return importAuto(file, declaredUnit ? { declaredUnit } : {})
}

async function stepConverter(): Promise<StepConverter> {
  return (await import('./import-step')).convertStep
}

/** Turns the engine's answer into plate entries, placed on the bed at the detected size. */
export function entriesFromImport(result: AutoImport, bed: Bed): { parts: MeshPart[]; name: string; colors: string[]; transform: number[] }[] {
  const scale = result.unit.autoApply ? result.unit.scale : 1
  const palette = result.slotColors.length ? result.slotColors : objectPalette()
  return result.objects
    .filter((o) => o.parts.some((p) => p.mesh.indices.length > 0))
    .map((o) => {
      const parts = o.parts.map((p) => fromGeom(p.mesh as GeomMesh, p.name || o.name, p.slot))
      let m = compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [scale, scale, scale] })
      m = dropToBed(parts, centerOnBed(parts, m, bed))
      return { parts, name: o.name || result.name, colors: parts.map((p) => o.parts.find((q) => (q.name || o.name) === p.name)?.color ?? palette[(p.slot - 1) % palette.length] ?? brandAccent()), transform: m }
    })
}

/**
 * Adds a file to the plate through the engine. `run` is the engine call and `step` the STEP reader (a
 * test passes its own). Returns the ids of the new objects. Nothing is added when any step fails.
 */
export async function addAutoImport(host: Host, name: string, data: ArrayBuffer, run: AutoRunner = engine, step?: StepConverter): Promise<string[]> {
  const format = autoFormatOf(name)
  if (!format) throw new Error(`${name} is not an STL, OBJ, AMF or STEP file`)
  let stepNotes: string[] = []
  let result: AutoImport
  if (format === 'step') {
    const convert = step ?? (await stepConverter())
    let mesh
    try {
      mesh = await convert({ name, data })
    } catch (e) {
      throw new Error(`${name} ${e instanceof Error ? e.message : 'could not be read.'}`)
    }
    stepNotes = mesh.notes
    result = await run({ base64: mesh.base64, name, format: 'obj', declaredUnit: 'millimeter' })
  } else result = await run({ base64: toBase64(data), name, format })
  const { bed } = get()
  const made = entriesFromImport(result, bed)
  if (made.length === 0) throw new Error(`${name} has no geometry`)
  const entries: PlateEntry[] = []
  for (const m of made) {
    const handle = await host.slicer.loadParts(m.name, m.parts)
    entries.push({ id: uid(), name: m.name, handle, parts: m.parts, colors: m.colors, transform: m.transform })
  }
  set((s) => ({ plate: [...s.plate, ...entries], selection: entries[0]!.id, selectedIds: entries.map((e) => e.id) }))
  if (entries.length > 1) await (await import('../plate/edit')).arrangePlate('all')
  markStale()
  const ids = entries.map((e) => e.id)
  const notes = [...stepNotes, ...result.summary]
  for (const w of result.warnings) if (!notes.includes(w)) notes.push(w)
  const u = result.unit
  // The repair details open from the toast when there is no unit undo to offer in its place.
  const fixes: RepairEntry[] = result.objects.map((o) => ({ label: o.name || result.name, report: o.repair }))
  const repairAction = fixes.some((e) => repairChanged(e.report)) ? { label: 'Repair details', run: () => showRepairReport({ title: `Repair report for ${name}`, entries: fixes }) } : null
  if (repairAction) rememberRepair({ title: `Repair report for ${name}`, entries: fixes })
  if (u.autoApply) {
    const size = u.sizeAfter.map((v) => `${Math.round(v * 10) / 10}`).join(' x ')
    notes.unshift(`${name} looked like ${u.unit === 'inch' ? 'inches' : u.unit === 'meter' ? 'meters' : u.unit}, so it was scaled to ${size} mm.`)
    toast(notes.join(' '), 'info', { label: 'Use as millimeters', run: () => useAsMillimeters(ids) })
  } else if (notes.length) toast(`${name}: ${notes.join(' ')}`, result.warnings.length ? 'warn' : 'info', repairAction ?? undefined)
  else toast(`Added ${name}`)
  return ids
}

/** Takes the unit scale back off the given objects (the undo for a detected unit). */
export function useAsMillimeters(ids: string[]): void {
  const { bed } = get()
  const mark = new Set(ids)
  set((s) => ({
    plate: s.plate.map((p) => {
      if (!mark.has(p.id)) return p
      let m = setScale(p.parts, p.transform, [1, 1, 1])
      m = dropToBed(p.parts, centerOnBed(p.parts, m, bed))
      return { ...p, transform: m }
    }),
  }))
  markStale()
}
