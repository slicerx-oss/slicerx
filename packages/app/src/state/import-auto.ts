// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opens an STL, OBJ, AMF or STEP through the geometry engine's automatic import: every mesh is
// repaired, the unit is detected (inch or meter files are scaled to millimeters, with a toast that
// undoes it) and a file with several loose bodies becomes several objects. Meshes arrive unscaled; the
// scale is the object's transform, so undoing it is one edit. A STEP file is meshed first in a worker
// of its own (import-step.ts) and arrives in millimeters, since STEP declares its unit.
import type { Bed, Host, MeshHandle, MeshPart } from '@slicerx/contracts'
import { isBinaryStl, sameMesh, scanStl } from '../export/stl-scan'
import { isBigSlice, sliceTimingsOf } from './slice-estimate'
import { inStep } from '../plate/history'
import { endIdleGeomWorker, fromGeom, toGeom, usesWorker, type GeomMesh } from '../geom/client'
import type { AutoImport, Unit } from '../geom/cad'
import type { StepConverter } from './import-step'
import { centerOnBed, compose, dropToBed, setScale, type Mat4 } from '../plate/transform'
import { repairChanged, rememberRepair, showRepairReport, type RepairEntry } from '../plate/repair-report'
import { appStore, get, markStale, set, toast, type AppState, type PlateEntry } from './store'
import { fitSettledFor, onFitSettled } from '../plate/fit-state'
import { brandAccent, objectPalette } from '../edition'
import type { OpenScope } from '../project/unsaved'
import { markOpenStage } from '../lib/open-mark'

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

/**
 * A file for the engine's import: as base64, as its bytes, which the geometry worker encodes off the page, or for a
 * binary STL, the mesh the page read from it (welded as the engine welds, export/stl-scan.ts).
 */
export type AutoFile = ({ base64: string } | { bytes: Uint8Array } | { stlMesh: { positions: Float32Array; indices: Uint32Array } }) & { name: string; format: MeshFormat; declaredUnit?: Unit }

export type AutoRunner = (file: AutoFile) => Promise<AutoImport>

async function engine({ declaredUnit, ...file }: AutoFile): Promise<AutoImport> {
  const { importAuto } = await import('../geom/cad')
  // A provider other than the app's worker (a test's) takes base64 and plain arrays only.
  const sent =
    usesWorker() ? file
    : 'bytes' in file ? { name: file.name, format: file.format, base64: toBase64(file.bytes) }
    : 'stlMesh' in file ? { name: file.name, format: file.format, stlMesh: { positions: Array.from(file.stlMesh.positions), indices: Array.from(file.stlMesh.indices) } }
    : file
  // The check for faces that cross each other runs after the model shows (checkCrossings): it is most of the import's time.
  return importAuto(sent, { ...(declaredUnit ? { declaredUnit } : {}), rebuildMaxTriangles: 0 })
}

/** The check for faces that cross each other on one part, as the engine runs it (a test passes its own). */
export type CrossingRunner = (part: MeshPart, perShell: boolean, signal?: AbortSignal) => Promise<{ crossing: boolean; mesh?: GeomMesh }>

export async function crossingEngine(part: MeshPart, perShell: boolean, signal?: AbortSignal): Promise<{ crossing: boolean; mesh?: GeomMesh }> {
  const { selfIntersections } = await import('../geom/cad')
  // The app's worker takes the typed arrays as they are; another provider takes plain arrays.
  try {
    return await selfIntersections(usesWorker() ? { positions: part.positions, indices: part.indices instanceof Uint32Array ? part.indices : Uint32Array.from(part.indices) } : toGeom(part), { perShell }, signal)
  } finally {
    // The check grows the worker's WebAssembly memory by about the mesh's size several times over; ending the worker
    // lets it go now. A canceled check also stops computing this way.
    endIdleGeomWorker()
  }
}

/**
 * When the crossing check may run: after the slice and the fit check, so it never adds its copies of a big mesh to
 * theirs. `wait` resolves once the plate is quiet; `onBusy` calls back when a slice or an open starts, which cancels a
 * check under way (it runs again once the plate is quiet).
 */
export interface Quiet {
  wait(): Promise<void>
  onBusy(cb: () => void): () => void
}

/** The longest the check waits for a quiet plate (ms): a fit check or a slice that never reports does not hold it for good. */
export const QUIET_MAX_MS = 60_000

/** Whether nothing the crossing check would compete with is under way or about to start. */
export function plateQuiet(s: AppState): boolean {
  if (s.plateLoading || s.slice.status === 'running') return false
  // Auto slice is about to slice a plate whose slice is not current (unless it holds a big one for Slice).
  const printable = s.plate.some((p) => p.printable !== false && p.parts.length > 0)
  if (s.autoSlice && !s.sliceHeld && printable && (s.slice.status === 'idle' || (s.slice.status === 'done' && s.slice.stale))) return false
  return fitSettledFor(s.plate)
}

/** Never while a file opens or a slice runs, even once the wait has run out. */
const notBusy = (s: AppState): boolean => !s.plateLoading && s.slice.status !== 'running'

export const plateQuietness: Quiet = {
  wait: () =>
    new Promise<void>((resolve) => {
      if (plateQuiet(get())) return resolve()
      let overdue = false
      const done = (): void => {
        offStore()
        offFit()
        clearTimeout(late)
        resolve()
      }
      const check = (): void => {
        const s = get()
        if (overdue ? notBusy(s) : plateQuiet(s)) done()
      }
      const offStore = appStore.subscribe(check)
      const offFit = onFitSettled(check)
      // A fit check or an auto slice that never reports does not hold the check for good; an open or a slice under
      // way still does.
      const late = setTimeout(() => {
        overdue = true
        check()
      }, QUIET_MAX_MS)
    }),
  onBusy: (cb) =>
    appStore.subscribe((s, prev) => {
      if ((s.slice.status === 'running' && prev.slice.status !== 'running') || (s.plateLoading && !prev.plateLoading)) cb()
    }),
}

async function stepConverter(): Promise<StepConverter> {
  return (await import('./import-step')).convertStep
}

/** Turns the engine's answer into plate entries, placed on the bed at the detected size. */
/**
 * The plate entries for an import. The objects keep their places relative to each other, as the file has them (one
 * model the engine split into loose bodies stays the model as designed): one placement for all of them, `base` when
 * the model already shows on the plate (its quick draw, maybe moved since), else centered on the bed and on it.
 */
export function entriesFromImport(result: AutoImport, bed: Bed, base?: Mat4): { parts: MeshPart[]; name: string; colors: string[]; transform: number[]; perShell: boolean }[] {
  const scale = result.unit.autoApply ? result.unit.scale : 1
  const palette = result.slotColors.length ? result.slotColors : objectPalette()
  const objects = result.objects
    .filter((o) => o.parts.some((p) => p.mesh.indices.length > 0))
    .map((o) => ({ o, parts: o.parts.map((p) => fromGeom(p.mesh, p.name || o.name, p.slot)) }))
  const all = objects.flatMap((x) => x.parts)
  const m = base ?? dropToBed(all, centerOnBed(all, compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [scale, scale, scale] }), bed))
  return objects.map(({ o, parts }) => ({
    perShell: o.perShell ?? false,
    parts,
    name: o.name || result.name,
    colors: parts.map((p) => o.parts.find((q) => (q.name || o.name) === p.name)?.color ?? palette[(p.slot - 1) % palette.length] ?? brandAccent()),
    transform: [...m],
  }))
}

/** Up to this size a binary STL is read on the page; a bigger one in the project worker, so the page keeps answering. */
const QUICK_ON_PAGE = 8 * 1024 * 1024

/**
 * Puts a binary STL on the plate from its own triangles, welded as the engine welds them first, before the engine's
 * import. Null when the file is not a binary STL or cannot be shown this way; the engine's import then shows it.
 */
async function showQuick(host: Host, name: string, data: ArrayBuffer, edit: (fn: () => void) => void, onRead: (mesh: { positions: Float32Array; indices: Uint32Array }) => void): Promise<{ id: string; part: MeshPart; handle: MeshHandle } | null> {
  const bytes = new Uint8Array(data)
  if (!isBinaryStl(bytes)) return null
  const onPage = bytes.length <= QUICK_ON_PAGE || typeof Worker === 'undefined'
  try {
    const mesh = onPage ? scanStl(bytes) : await (await import('../export/project-worker-client')).scanStlInWorker(bytes)
    if (!mesh || mesh.indices.length === 0) return null
    onRead(mesh)
    markOpenStage('parse', { parsedIn: onPage ? 'page' : 'worker' })
    const part: MeshPart = { name, slot: 1, positions: mesh.positions, indices: mesh.indices }
    const handle = await host.slicer.loadParts(name, [part])
    markOpenStage('engine')
    const transform = dropToBed([part], centerOnBed([part], compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), get().bed))
    const id = uid()
    const color = objectPalette()[0] ?? brandAccent()
    // A small slice may start on it now; if the engine's import changes it, that slice goes stale with the change. A big
    // one waits for the open to end and the fit check (slice-estimate.ts), so the copies of a big model are not all
    // alive at once.
    edit(() =>
      set((s) => {
        const plate = [...s.plate, { id, name, handle, parts: [part], colors: [color], transform }]
        return { plate, selection: id, selectedIds: [id], sliceDuringOpen: !isBigSlice(plate, sliceTimingsOf(s.activePlate)) }
      }),
    )
    markOpenStage('objects')
    return { id, part, handle }
  } catch {
    return null
  }
}

/**
 * Adds a file to the plate through the engine. `run` is the engine call and `step` the STEP reader (a
 * test passes its own). Returns the ids of the new objects. Nothing is added when any step fails.
 */
export async function addAutoImport(host: Host, name: string, data: ArrayBuffer, run: AutoRunner = engine, step?: StepConverter, scope?: OpenScope, cross: CrossingRunner = crossingEngine): Promise<string[]> {
  const format = autoFormatOf(name)
  if (!format) throw new Error(`${name} is not an STL, OBJ, AMF or STEP file`)
  // One undo step for the object shown at once and the engine's import that may replace it.
  const token = {}
  const edit = (fn: () => void) => inStep(token, () => (scope ? scope.run(fn) : fn()))
  // The engine's import runs in the geometry worker. A binary STL is read on the page first and goes on the plate from
  // its own triangles; the import, which takes far longer, starts on that read mesh as soon as it is there, so the
  // engine neither decodes nor reads the file again. Any other file goes to the import as it is, at once.
  let started = null as Promise<AutoImport> | null
  const start = (file: AutoFile) => {
    started = run(file)
    started.catch(() => undefined)
  }
  if (format !== 'step' && !(format === 'stl' && isBinaryStl(new Uint8Array(data)))) start({ bytes: new Uint8Array(data), name, format })
  const quick = format === 'stl' ? await showQuick(host, name, data, edit, (stlMesh) => start({ stlMesh, name, format })) : null
  // A binary STL the page could not read (a corner that is not a number) goes to the import as a file after all.
  if (format !== 'step' && !started) start({ bytes: new Uint8Array(data), name, format })
  let stepNotes: string[] = []
  let result: AutoImport
  try {
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
    } else result = await started!
  } catch (e) {
    // Without the engine's import (a host with no engine, or a failure) the model stays as it was read.
    if (!quick) throw e
    markStale()
    toast(`Added ${name}`)
    return [quick.id]
  }
  const { bed } = get()
  // The model already on the plate from its quick draw keeps its place (and any move made while it loaded): the engine's
  // objects are in the file's own coordinates, as it was, unless the engine changed the unit.
  const shown = quick && !result.unit.autoApply ? get().plate.find((p) => p.id === quick.id)?.transform : undefined
  const made = entriesFromImport(result, bed, shown)
  if (!quick) markOpenStage('parse', { parsedIn: 'worker' })
  const here = quick ? get().plate.find((p) => p.id === quick.id) : undefined
  // The engine changed nothing (no repair, one body, millimeters): the object on the plate is already its result.
  const same = here && made.length === 1 && made[0]!.parts.length === 1 && !result.unit.autoApply && sameMesh(made[0]!.parts[0]!, quick!.part)
  let entries: PlateEntry[]
  if (same) entries = [here]
  else {
    if (made.length === 0) {
      if (quick) edit(() => set((s) => ({ plate: s.plate.filter((p) => p.id !== quick.id) })))
      throw new Error(`${name} has no geometry`)
    }
    entries = []
    // pieces split from one model share a key, so the fit check keeps quiet about them touching
    const split = made.length > 1 ? uid() : undefined
    for (const m of made) {
      const handle = await host.slicer.loadParts(m.name, m.parts)
      entries.push({ id: uid(), name: m.name, handle, parts: m.parts, colors: m.colors, transform: m.transform, ...(split ? { splitOf: split } : {}) })
    }
    if (!quick) markOpenStage('engine')
    // The engine's result takes the place of the object shown before it.
    edit(() => set((s) => ({ plate: [...s.plate.filter((p) => p.id !== quick?.id), ...entries], selection: entries[0]!.id, selectedIds: entries.map((e) => e.id) })))
    if (quick) host.slicer.release?.(quick.handle.id)
    if (!quick) markOpenStage('objects')
  }
  markOpenStage('repair')
  // Objects split from one model keep their places, so nothing on the plate moves after it first shows. The object
  // shown first that stayed as it was keeps a slice of it, started while the open ran.
  if (!same || entries.length > 1) markStale()
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
  if (run === engine) void checkCrossings(host, name, entries.map((e, i) => ({ id: e.id, perShell: same ? (made[0]?.perShell ?? true) : (made[i]?.perShell ?? false) })), cross, edit)
  return ids
}

/**
 * After the model shows: each part checked for faces that cross each other, as the import used to before showing it. A
 * part small enough is rebuilt without the crossings and takes the place of the one on the plate, in the open's undo
 * step when nothing else was edited meanwhile; a bigger one gets a note. A part that changed meanwhile is left alone.
 */
export async function checkCrossings(host: Host, name: string, objects: { id: string; perShell: boolean }[], cross: CrossingRunner, edit: (fn: () => void) => void = (fn) => fn(), quiet: Quiet = plateQuietness): Promise<{ fixed: number; left: number }> {
  let fixed = 0
  let left = 0
  for (const o of objects) {
    // One part at a time, each once the plate is quiet (after the slice and the fit check). A slice or an open that
    // starts meanwhile cancels it, and it runs again when the plate is quiet once more.
    const start = get().plate.find((p) => p.id === o.id)
    if (!start) continue
    for (let i = 0; i < start.parts.length; i++) {
      let r: { crossing: boolean; mesh?: GeomMesh } | null = null
      let part = start.parts[i]!
      for (;;) {
        await quiet.wait()
        const now = get().plate.find((p) => p.id === o.id)
        if (!now || !now.parts[i]) break
        part = now.parts[i]!
        const ac = new AbortController()
        const off = quiet.onBusy(() => ac.abort())
        try {
          r = await cross(part, o.perShell, ac.signal)
        } catch {
          r = null
        } finally {
          off()
        }
        if (!ac.signal.aborted) break
        r = null
      }
      if (!r) continue
      if (!r.crossing) continue
      if (!r.mesh) {
        left++
        continue
      }
      const now = get().plate.find((p) => p.id === o.id)
      if (now?.parts[i] !== part) continue
      const parts = now.parts.map((p, k) => (k === i ? fromGeom(r.mesh!, part.name, part.slot) : p))
      const handle = await host.slicer.loadParts(now.name, parts)
      const still = get().plate.find((p) => p.id === o.id)
      if (still?.parts !== now.parts) {
        host.slicer.release?.(handle.id)
        continue
      }
      edit(() => set((s) => ({ plate: s.plate.map((p) => (p.id === o.id ? { ...p, parts, handle } : p)) })))
      host.slicer.release?.(now.handle.id)
      fixed++
    }
  }
  if (fixed) {
    markStale()
    toast(`${name}: Repaired: fixed self-intersections in ${fixed} ${fixed === 1 ? 'part' : 'parts'}.`)
  }
  if (left) toast(`${name}: ${left} ${left === 1 ? 'part still crosses itself' : 'parts still cross themselves'} (too large to rebuild during import).`, 'warn')
  return { fixed, left }
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
