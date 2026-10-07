// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// User actions that touch the host: loading models, slicing, export, sending
// to a printer. Commands, buttons and Pilot tools all call these.
import { isGcodeName, openGcodeRef } from '../workspaces/preview/gcode-file'
import type { ApprovalHost, ApprovalRequest, ApprovalToken, FileRef, Host, JobFile, LayerGcode, PermissionClass, PlateObject, PrintConfig, PrinterHost, PrinterInfo, PrinterStatus, SettingValue, SideEffectAction, SlicerHost } from '@slicerx/contracts'
import { followsSlotMap, grantApproval, hashParams, readPreview, slotMapLine } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { DEFAULT_MODEL, demoModel } from '../lib/demo-models'
import { formatDuration } from '../lib/preview-stats'
import type { DecodedModel } from '@slicerx/embed/mesh'
import { resumeSliceOptions } from '../geom/resume'
import { resolveSlots, slotConfig, slotOverridesFor, usedSlots } from '../filament/slots'
import type { QueueItem } from '../queue/queue'
import type { PrintSheetAsk } from '../send/print-sheet'
import { EXTERNAL_SLOT, matchSlots, mergeOptions, printEnding, withEnding, optionLines, slotMapFor, startSlotMap, supportedOptions, withoutSlotMap, type SendChoice, type SendOptionSpec, type SendOptions } from '../send/options'
import { bake } from '../plate/mesh-ops'
import { bounds, compose } from '../plate/transform'
import { requestVolumes } from '../plate/volumes'
import { areaOrigin, objectToMachine, towerToPlate } from '../plate/bed-origin'
import { holdUpdates } from '../updates/hold'
import { exportPlateGcode, sha256Hex } from '../calibration/gcode'
import { sliceHandle } from '../plate/painted'
import { nameOptions, plateConfig } from '../plate/plates'
import { plateSequence } from '../plate/plate-sequence'
import { layerHeightConflict, objectOverrides, partOverridesOf } from '../plate/object-settings'
import { printBlock } from '../plate/heimdall'
import { clearProject } from '../project/new'
import { confirmDiscard, markClean } from '../project/unsaved'
import { isExportOnly } from '../lib/hand-printers'
import { get, markStale, set, toast, type AppState, type PlateEntry, type PlateMeta, selectedIds, type PendingApproval, type ModelSource, type PlateVolumeEntry } from './store'
import { appName, brandAccent, objectPalette } from '../edition'
import { handOffCopy, handToBambuConnect, onLinux, printRoute } from '../send/bambu-connect'
import { openLink } from '../lib/links'


let sliceAbort: AbortController | null = null
let seq = 0
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** Places the object at the bed center; models are stored centered on X and Y. */
function centered(bedW: number, bedD: number): number[] {
  const t = identity()
  t[12] = bedW / 2
  t[13] = bedD / 2
  return t
}

async function addDecoded(host: Host, model: DecodedModel, opts: { replace: boolean; thumb?: string }): Promise<PlateEntry> {
  const handle = await host.slicer.loadParts(model.name, model.parts)
  const { bed } = get()
  const entry: PlateEntry = {
    id: uid('obj'),
    name: model.name,
    handle,
    parts: model.parts,
    colors: model.colors,
    transform: centered(bed.widthMm, bed.depthMm),
    ...(opts.thumb ? { thumb: opts.thumb } : {}),
  }
  set((s) => ({ plate: opts.replace ? [entry] : [...s.plate, entry], selection: entry.id }))
  markStale()
  return entry
}

/** Puts one of the built-in example models on the plate. */
export async function loadDemoModel(host: Host, slug: string, opts: { replace?: boolean } = {}): Promise<void> {
  const demo = demoModel(slug)
  if (!demo) {
    toast(`No example model called ${slug}`, 'error')
    return
  }
  set({ plateLoading: true })
  try {
    const { parts, colors } = demo.build()
    const model: DecodedModel = { name: demo.name, bboxMm: [0, 0, 0], triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), parts, colors }
    await addDecoded(host, model, { replace: opts.replace ?? true })
    if (opts.replace ?? true) {
      set({ slice: { status: 'idle' }, preview: null, projectFile: null })
      markClean()
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not load the model', 'error')
  } finally {
    set({ plateLoading: false })
  }
}

/** The plate a fresh session opens with. */
export function loadDefaultPlate(host: Host): Promise<void> {
  return loadDemoModel(host, DEFAULT_MODEL, { replace: true })
}

/** Open (the default) starts a new project with the files; `fresh: false` is Add model, onto the plate as it is. */
export async function openModelFiles(host: Host, opts: { fresh?: boolean } = {}): Promise<void> {
  const refs = await host.files.open({ accept: ['.stl', '.3mf', '.sx3mf', '.sxlock', '.obj', '.amf', '.step', '.stp', '.json', '.gcode'], multiple: true })
  await addFileRefs(host, refs, { fresh: opts.fresh ?? true })
}

/** A new project for an opened design: asks about unsaved work first (Save, Discard, Cancel). False when canceled. */
async function startFresh(): Promise<boolean> {
  if (!(await confirmDiscard('open another design'))) return false
  clearProject()
  return true
}

/**
 * Opens a 3MF project with its objects, parts and volumes (negative parts, support blockers and
 * enforcers). Returns false when the file is not one we can read as a project, so the caller falls back
 * to the engine's own loader.
 */
async function addProject(host: Host, data: ArrayBuffer, name: string): Promise<boolean> {
  const { readProject, ProjectReadError } = await import('../export/import3mf')
  const { bed } = get()
  let project
  try {
    project = await readProject(new Uint8Array(data), bed)
  } catch (e) {
    if (e instanceof ProjectReadError && /too many|too large|unsafe|encrypted|inflates|damaged/.test(e.message)) throw e
    return false
  }
  const { addPlate, switchPlate } = await import('../plate/plates')
  const wasEmpty = get().plates.every((p) => p.objects.length === 0) && get().plate.length === 0
  const startPlate = get().activePlate
  // Ids up front, so kept dimensions can name objects on any plate.
  const idOf = new Map<string, string>()
  for (const pl of project.plates) for (const o of pl.objects) if (!idOf.has(o.fileId)) idOf.set(o.fileId, uid('obj'))
  const dimsOf = (fileId: string) =>
    project.dimensions
      .filter((d) => d.a.object === fileId)
      .map((d) => ({ ...d, a: { ...d.a, object: idOf.get(d.a.object)! }, ...(d.b ? { b: { ...d.b, object: idOf.get(d.b.object)! } } : {}) }))
  if (project.historyNote) toast(project.historyNote, 'warn')
  // Named values come with the project; a name the open project already has keeps its own value.
  if (project.namedValues.length) {
    set((s) => ({ namedValues: [...s.namedValues, ...project.namedValues.filter((v) => !s.namedValues.some((o) => o.name === v.name))] }))
  }
  const placed = new Set<string>()
  const entries = async (objects: typeof project.plates[number]['objects']): Promise<PlateEntry[]> => {
    const out: PlateEntry[] = []
    for (const o of objects) {
      const handle = await host.slicer.loadParts(o.name, o.parts)
      const volumes: PlateVolumeEntry[] = []
      for (const v of o.volumes) {
        // Centered on its own origin with the placement in `local`, so the position fields read as an offset.
        const b = bounds([v.part], identity())
        const c: [number, number, number] = b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] : [0, 0, 0]
        const move = (d: [number, number, number]) => compose({ position: d, rotation: [0, 0, 0], scale: [1, 1, 1] })
        const centeredPart = bake(v.part, move([-c[0], -c[1], -c[2]]))
        const vh = await host.slicer.loadParts(v.name, [centeredPart])
        const mod = v.role === 'modifier' && v.rawSettings ? (await import('../export/project-settings')).modifierSettings(v.rawSettings) : undefined
        volumes.push({ id: uid('vol'), name: v.name, role: v.role, handle: vh, part: centeredPart, local: move(c), ...(mod && Object.keys(mod).length ? { settings: mod } : {}) })
      }
      const palette = objectPalette()
      const colors = project.colors.length ? project.colors : palette
      const partSettings: Record<string, Record<string, SettingValue>> = {}
      for (const [part, raw] of Object.entries(o.rawPartSettings ?? {})) {
        const v = (await import('../export/project-settings')).modifierSettings(raw)
        if (Object.keys(v).length) partSettings[part] = v
      }
      // A file object placed twice keeps its dimensions on the first placement only.
      const first = !placed.has(o.fileId)
      placed.add(o.fileId)
      const dims = first ? dimsOf(o.fileId) : []
      // So does its CAD history, which needs the parts to be the ones it made.
      const history = first ? project.histories.get(o.fileId) : undefined
      out.push({ id: first ? idOf.get(o.fileId)! : uid('obj'), name: o.name, ...(dims.length ? { dimensions: dims } : {}), ...(history ? { history } : {}), handle, parts: o.parts, ...(Object.keys(partSettings).length ? { partSettings } : {}), colors: o.parts.map((p) => colors[p.slot - 1] ?? palette[0]!), transform: o.transform, ...(o.paint ? { paint: o.paint } : {}), ...(o.printable === false ? { printable: false } : {}), ...(o.brimPoints?.length ? { brimPoints: o.brimPoints } : {}), ...(volumes.length ? { volumes } : {}), ...(o.source ? { source: o.source } : {}) })
    }
    return out
  }
  for (const [i, plate] of project.plates.entries()) {
    if (plate.objects.length === 0) continue
    const made = await entries(plate.objects)
    if (i > 0) {
      const id = addPlate({ ...(plate.sequence ? { sequence: plate.sequence } : {}), ...(plate.nozzleMap ? { nozzleMap: plate.nozzleMap } : {}) })
      set((s) => ({ plates: s.plates.map((p) => (p.id === id ? { ...p, name: plate.name } : p)) }))
    }
    set((s) => ({ plate: [...s.plate, ...made], selection: made[0]?.id ?? s.selection }))
    if (plate.marks?.length) {
      const { customGcodeProblem, markId } = await import('../plate/layer-marks')
      // Custom text from a file is untrusted: it passes the same check as text typed in.
      const ok = plate.marks.filter((m) => m.kind !== 'custom' || customGcodeProblem(m.gcode ?? '') === null).map((m) => ({ id: markId(), z: m.z, kind: m.kind, ...(m.kind === 'custom' ? { gcode: (m.gcode ?? '').trim() } : {}) }))
      set((s) => ({ layerMarks: { ...s.layerMarks, [s.activePlate]: [...(s.layerMarks[s.activePlate] ?? []), ...ok].sort((a, b) => a.z - b.z) } }))
    }
    const sequence = plate.sequence
    if (i === 0 && sequence) set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, sequence } } : p)) }))
    const nozzleMap = plate.nozzleMap
    if (i === 0 && nozzleMap) set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, nozzleMap } } : p)) }))
  }
  switchPlate(startPlate)
  // An Orca or Bambu Studio project (anything but our .sx3mf) opens with its own fixed layers, so
  // sleipnir goes off and the layer count matches the slicer that made it.
  if (wasEmpty && !/\.sx3mf$/i.test(name)) set((s) => ({ easy: { ...s.easy, varyLayerHeight: false }, goal: 'custom' as const }))
  // A project's own print and filament settings come along when it opens on an empty project.
  if (wasEmpty && Object.keys(project.settings).length) {
    const { projectSettingChanges } = await import('../export/project-settings')
    const { values } = projectSettingChanges(project.settings, resolveConfig(get().easy, get().overrides))
    const n = Object.keys(values).length
    if (n) {
      set((s) => ({ overrides: { ...s.overrides, ...values }, goal: 'custom' as const }))
      toast(`Applied ${n} settings from ${name}`, 'info')
    }
    // Its printer G-code: stock text needs nothing, anything else waits for the person at the next slice.
    await (await import('./project-gcode')).reviewOpenedGcode(name, project.settings)
  }
  markStale()
  return true
}

/** Returns true when it already told the person what it did (a toast of its own). */
async function addBytes(host: Host, name: string, data: ArrayBuffer): Promise<boolean> {
  if (/\.(stl|obj|amf|step|stp)$/i.test(name)) {
    // Every mesh goes through the engine: repaired, unit detected, loose bodies split. STEP files are
    // meshed first in a worker of their own.
    const { addAutoImport } = await import('./import-auto')
    try {
      await addAutoImport(host, name, data)
    } catch (e) {
      // Without the engine (a host that has none) an STL still opens, unrepaired.
      if (!/\.stl$/i.test(name)) throw e
      const { decodeStl } = await import('@slicerx/embed/mesh')
      try {
        await addDecoded(host, decodeStl(data, name), { replace: false })
      } catch {
        throw e
      }
      return false
    }
    return true
  } else if (/\.json$/i.test(name)) {
    const { decodeQuantized } = await import('@slicerx/embed/mesh')
    const json: unknown = JSON.parse(new TextDecoder().decode(data))
    await addDecoded(host, decodeQuantized(json), { replace: false })
  } else if (await addProject(host, data, name)) {
    // A project with objects, parts and volumes opened as such.
  } else {
    // 3MF geometry for the viewport arrives with the core's mesh export; slice it meanwhile.
    const handle = await host.slicer.loadModel(data, name)
    // A Vault design stays one when the engine opens it.
    const source = await (await import('../export/import3mf')).vaultSourceOf(new Uint8Array(data))
    const { bed } = get()
    set((s) => ({
      plate: [...s.plate, { id: uid('obj'), name: handle.name, handle, parts: [], colors: handle.parts.map((p) => p.color ?? brandAccent()), transform: centered(bed.widthMm, bed.depthMm), ...(source ? { source } : {}) }],
    }))
    markStale()
  }
  return false
}

/**
 * Opens model bytes that came from somewhere other than a file dialog (a download, a feature). `fresh` (a Vault design,
 * a recent project) starts a new project; otherwise they go onto the plate as it is.
 */
export async function openModelBytes(host: Host, name: string, data: ArrayBuffer, source?: ModelSource, opts: { fresh?: boolean } = {}): Promise<void> {
  if (opts.fresh && !(await startFresh())) return
  set({ plateLoading: true })
  try {
    const before = new Set(get().plate.map((p) => p.id))
    const told = await addBytes(host, name, data)
    // A model from the library keeps its model and creator ids for the sx3mf it is saved in.
    if (source && (source.modelId || source.creatorId)) set((s) => ({ plate: s.plate.map((p) => (before.has(p.id) ? p : { ...p, source })) }))
    if (opts.fresh) markClean()
    if (!told) toast(`Added ${name}`)
  } catch (e) {
    toast(e instanceof Error ? e.message : `Could not open ${name}`, 'error')
  } finally {
    set({ plateLoading: false })
  }
}

/** `fresh`: the files start a new project (Open); otherwise they go onto the plate as it is (Add model, a drop). */
export async function addFileRefs(host: Host, refs: FileRef[], opts: { fresh?: boolean } = {}): Promise<void> {
  // A G-code file opens in Preview to view, not on the plate.
  const gcode = refs.filter((r) => isGcodeName(r.name))
  if (gcode.length) {
    await openGcodeRef(host, gcode[gcode.length - 1] as FileRef)
    refs = refs.filter((r) => !isGcodeName(r.name))
  }
  if (refs.length === 0) return
  // A locked project is unlocked first, so a refusal (offline, another account) changes nothing on the plate.
  const unlocked = refs.some((r) => /\.sxlock$/i.test(r.name)) ? await (await import('../export/locked')).unlockRefs(host, refs) : new Map<FileRef, { name: string; data: ArrayBuffer }>()
  if (!unlocked) return
  const project = refs.some((r) => /\.(sx3mf|3mf|sxlock)$/i.test(r.name))
  if (opts.fresh && !(await startFresh())) return
  const wasEmpty = get().plate.length === 0 && get().plates.every((p) => p.objects.length === 0)
  set({ plateLoading: true })
  try {
    let told = false
    for (const ref of refs) {
      const open = unlocked.get(ref)
      const name = open?.name ?? ref.name
      const data = open?.data ?? (await host.files.read(ref))
      // A copy is taken first: a worker may take the original. A locked project is never kept unlocked in recents.
      const keep = !open && /\.(sx3mf|3mf)$/i.test(name) ? data.slice(0) : null
      told = (await addBytes(host, name, data)) || told
      if (keep) void import('../project/autosave').then((m) => m.recordRecent(name, keep))
    }
    if (opts.fresh) markClean()
    if (project && wasEmpty) {
      // Save writes back to an opened .sx3mf; another slicer's 3MF is saved as a new file.
      const only = refs.length === 1 ? refs[0] : undefined
      set({ projectFile: only?.path && /\.sx3mf$/i.test(only.name) ? only : null })
      markClean()
    }
    if (!told || refs.length > 1) toast(refs.length === 1 ? `Added ${refs[0]?.name ?? 'model'}` : `Added ${refs.length} models`)
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not open the file')
  } finally {
    set({ plateLoading: false })
  }
}

export function removeSelected(): void {
  const ids = new Set(selectedIds())
  if (ids.size === 0) return
  const { plate } = get()
  set({ plate: plate.filter((p) => !ids.has(p.id)), selection: null, selectedIds: [] })
  markStale()
}

export function clearPlate(): void {
  set({ plate: [], selection: null, slice: { status: 'idle' }, preview: null })
}

function overridesOf(meta: PlateMeta | undefined, p: PlateEntry): { slotOverrides?: Record<string, number> } {
  const o = slotOverridesFor(meta, p)
  return o ? { slotOverrides: o } : {}
}

/** The resolved config a plate slices with: profile and Easy choices, overrides, filament slots and the plate's own settings. */
export function plateSliceConfig(s: AppState, meta: PlateMeta | undefined): PrintConfig {
  return { ...resolveConfig(s.easy, s.overrides), ...slotConfig(s), ...plateConfig(meta) }
}

/**
 * The engine's objects for a plate's printable entries: placement, slot overrides, volumes, object and part settings and
 * brim ears. Painted color goes to the engine inside a 3MF, so a painted object slices with that model's handle.
 */
export async function plateObjects(slicer: Pick<SlicerHost, 'loadModel'>, s: AppState, meta: PlateMeta | undefined, entries: readonly PlateEntry[]): Promise<PlateObject[]> {
  const toPrint = entries.filter((p) => p.printable !== false)
  const handles = await Promise.all(toPrint.map((p) => sliceHandle(slicer, p)))
  // The plate counts from its front left corner; the engine takes machine coordinates.
  const origin = areaOrigin(resolveConfig(s.easy, s.overrides)['printable_area'])
  return toPrint.map((p, i) => objectToMachine({ id: p.id, name: p.name, mesh: handles[i]!.id, transform: p.transform, ...overridesOf(meta, p), ...(p.volumes?.length ? { volumes: requestVolumes(p) } : {}), ...(Object.keys(objectOverrides(s, p)).length ? { settings: objectOverrides(s, p) } : {}), ...(Object.keys(partOverridesOf(entries, p)).length ? { partSettings: partOverridesOf(entries, p) } : {}), ...(p.brimPoints?.length ? { brimPoints: p.brimPoints } : {}) }, origin))
}

/**
 * What the engine may trust and the limits of the target printer. The custom G-code is trusted only when it is the text
 * shipped for the selected model and the person has overridden none of the G-code settings (a user edit, an imported
 * preset or project), except with a project's G-code the person chose in the project G-code dialog and has not edited
 * since. Everything else gets the strict linter.
 */
export function trustOptions(s: Pick<AppState, 'profile' | 'overrides'> & Partial<Pick<AppState, 'vouchedGcode'>>): { trustedGcode?: true; machineLimits?: { nozzleMaxC?: number; bedMaxC?: number } } {
  const p = s.profile
  if (!p) return {}
  const vouched = s.vouchedGcode ?? {}
  const own = (k: string): boolean => k in s.overrides && !(k in vouched && JSON.stringify(s.overrides[k]) === JSON.stringify(vouched[k]))
  const edited = p.gcodeKeys.some(own) || GCODE_TEXT_KEYS.some(own)
  return { ...(p.shippedGcode && !edited ? { trustedGcode: true as const } : {}), ...(Object.keys(p.limits).length ? { machineLimits: p.limits } : {}) }
}

export const GCODE_TEXT_KEYS = ['machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode', 'change_filament_gcode', 'filament_start_gcode', 'filament_end_gcode', 'machine_pause_gcode', 'template_custom_gcode', 'time_lapse_gcode', 'toolchange_gcode', 'wrapping_detection_gcode', 'file_start_gcode', 'extruder_start_gcode', 'printing_by_object_gcode', 'change_extrusion_role_gcode', 'filament_change_extrusion_role_gcode', 'process_change_extrusion_role_gcode']

/** `auto` is a background slice after an edit: nothing to say when there is nothing to slice, and a failure shows in the panel, not as a toast. */
export async function slicePlate(host: Host, opts: { auto?: boolean } = {}): Promise<void> {
  // The printer, filament and process layer must match the printer and quality tier before the configuration is read.
  await (await import('./profile-sync')).profileReady()
  // A project's own printer G-code waits for the person: a slice they start asks first, a background slice uses the
  // profile's until they choose.
  if (!opts.auto && get().projectGcode && get().plate.length > 0) {
    if ((await (await import('./project-gcode')).askProjectGcode()) === null) return
  }
  const s = get()
  if (s.plate.length === 0) {
    if (!opts.auto) toast('Add a model to the plate first')
    return
  }
  if (s.plate.every((p) => p.printable === false)) {
    if (!opts.auto) toast('Every object on this plate is set not to print. Turn one on first.')
    return
  }
  const base = resolveConfig(s.easy, s.overrides)
  const seqNow = plateSequence(s.plates.find((p) => p.id === s.activePlate), base)
  const plateLayer = base['layer_height']
  const conflict = layerHeightConflict(s, seqNow, typeof plateLayer === 'number' ? plateLayer : 0.2)
  if (conflict) {
    set({ slice: { status: 'error', message: conflict } })
    return
  }
  sliceAbort?.abort()
  const abort = new AbortController()
  sliceAbort = abort
  set({ slice: { status: 'running', progress: null, startedAt: performance.now() } })
  try {
    // The plate's own print sequence (Bambu Studio and Orca set it per plate).
    const meta = s.plates.find((p) => p.id === s.activePlate)
    const config = plateSliceConfig(s, meta)
    const toPrint = s.plate.filter((p) => p.printable !== false)
    const objects = await plateObjects(host.slicer, s, meta, s.plate)
    // sleipnir plans the layer tops; a calibration plate keeps its own height bands.
    // Vary layer height reaches the engine as the resolved `smart_layer` mode (quality, or strength for a strong print).
    const smart = (String((config as Record<string, unknown>)['smart_layer'] ?? 'off') as 'off' | 'quality' | 'strength')
    const planned = smart !== 'off' && !s.calibration[s.activePlate] ? await (await import('../plate/smart-layer')).planSmartLayers(toPrint, config, smart).catch(() => null) : null
    // A resume plan restarts the failed job's layers, so its layer tops win over a fresh plan.
    const layerTopsMm = s.resume?.layerTopsMm?.length ? s.resume.layerTopsMm : planned
    // Marks from the layer slider (pause, color change, custom G-code) go by height: the engine places them on its own
    // layers, so a plate whose layer plan only the engine knows (sleipnir color bands) slices once.
    const marks = get().layerMarks[s.activePlate] ?? []
    const calibGcode = s.calibration[s.activePlate]?.layerGcode ?? []
    const layerGcode: LayerGcode[] = [...calibGcode, ...(marks.length ? (await import('../plate/layer-marks')).layerGcodeByHeight(marks) : [])]
    const sliceWith = async () =>
      host.slicer.slice(
        {
          plate: {
            bed: s.bed,
            objects,
          },
          config,
          options: { emitGcode: true, emitPreview: true, shards: host.kind === 'desktop' ? 1 : host.capabilities.threads, ...trustOptions(s), ...nameOptions(s), ...(s.profile?.printerId ? { printerId: s.profile.printerId } : {}), ...(layerTopsMm ? { layerTopsMm } : {}), ...(s.calibration[s.activePlate] ? { heightRanges: s.calibration[s.activePlate]!.ranges } : {}), ...(layerGcode.length ? { layerGcode } : {}), ...(s.resume ? resumeSliceOptions(s.resume.plan, s.resume.declareZ) : {}) },
        },
        {
          signal: abort.signal,
          onProgress: (progress) => {
            const cur = get().slice
            if (cur.status === 'running' && sliceAbort === abort) set({ slice: { ...cur, progress } })
          },
        },
      )
    // The native engine already spreads layers across threads; shards there only add halo work.
    const sliced = await sliceWith()
    if (sliceAbort !== abort) return
    // The tower comes back in machine coordinates; the plate counts from its corner.
    const result = sliced.primeTower ? { ...sliced, primeTower: towerToPlate(sliced.primeTower, areaOrigin(config['printable_area'])) } : sliced
    const raw = await host.slicer.getPreview(result.id)
    const preview = readPreview(raw)
    const cur = get()
    set({ slice: { status: 'done', result, stale: false }, preview, strikePick: null, strikeJump: null, strikeHover: null, ...layersAfterSlice(cur, preview.layerCount, cur.norn.before !== null) })
  } catch (e) {
    if (abort.signal.aborted) {
      // A newer slice may already be running; its state is not ours to reset.
      if (sliceAbort === abort) set({ slice: { status: 'idle' } })
      return
    }
    const message = e instanceof Error ? e.message : String(e)
    set({ slice: { status: 'error', message } })
    if (!opts.auto) toast(message, 'error')
  } finally {
    if (sliceAbort === abort) sliceAbort = null
  }
}

export function cancelSlice(opts: { quiet?: boolean } = {}): void {
  if (sliceAbort) {
    sliceAbort.abort()
    if (!opts.quiet) toast('Slice canceled')
  }
}

/** Whether a slice is in flight. */
export const slicing = (): boolean => sliceAbort !== null

/** "Desk hook" becomes "desk-hook_plate-1.gcode". */
/** What a printer that does not follow a slot map does with a plain G-code file: each filament from the slot of its number. */
function gcodeSlotsLine(fixed: Record<number, string>): string {
  return `Filament slots: as the G-code says, ${Object.entries(fixed)
    .map(([n, id]) => `filament ${n} from ${id === EXTERNAL_SLOT ? 'the external spool' : `slot ${id}`}`)
    .join(', ')}`
}

/**
 * The job's name: the object's own on a plate of one, else the plate's, so a new print order does not rename it after
 * whichever object now prints first.
 */
export function jobName(s: Pick<AppState, 'plate' | 'plates' | 'activePlate'>): string {
  const printable = s.plate.filter((p) => p.printable !== false)
  if (printable.length === 1) return printable[0]!.name
  return s.plates.find((p) => p.id === s.activePlate)?.name ?? 'Plate 1'
}

/**
 * The file name for the slice: the engine's (Orca's `filename_format`, which starts with the first object's name), with
 * that start swapped for the job's name on a plate of more than one object.
 */
export function jobFileName(s: Pick<AppState, 'plate' | 'plates' | 'activePlate'>, engine: string | undefined): string {
  const job = jobName(s)
  if (!engine) return gcodeName(job)
  const first = s.plate.find((p) => p.printable !== false)?.name
  if (!first || job === first || !engine.startsWith(first)) return engine
  return job + engine.slice(first.length)
}

function gcodeName(plate: string): string {
  const slug = plate.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plate'
  return `${slug}_plate-1.gcode`
}

export async function exportGcode(host: Host): Promise<void> {
  const s = get().slice
  if (s.status !== 'done') {
    toast('Slice the plate first')
    return
  }
  // A slice with a strike, or from before the objects moved, must not leave as the plate's G-code.
  const unsafe = printBlock(get())
  if (unsafe) {
    toast(unsafe, 'error')
    return
  }
  const name = jobFileName(get(), s.result.fileName)
  const out = await exportPlateGcode(host, s.result.id)
  if (out.blob) await host.files.save(name, out.blob, { accept: [name.endsWith('.bgcode') ? '.bgcode' : '.gcode'] })
  toast(`Exported ${name}`)
}

/**
 * One approval covering one or more host calls. Each action's hash is the
 * hash of the exact parameters the host will see (packages/contracts/src/pilot.ts).
 */
export async function buildApproval(opts: {
  tool: string
  permission: PermissionClass
  title: string
  lines: string[]
  printerId?: string
  actions: { action: SideEffectAction; target: string; params: unknown }[]
}): Promise<ApprovalRequest> {
  const actions = await Promise.all(opts.actions.map(async (a) => ({ action: a.action, target: a.target, paramsHash: await hashParams(a.params) })))
  return {
    id: uid('apr'),
    sessionId: 'ui',
    tool: opts.tool,
    permission: opts.permission,
    title: opts.title,
    lines: opts.lines,
    ...(opts.printerId ? { printerId: opts.printerId } : {}),
    paramsHash: await hashParams(opts.actions.map((a) => a.params)),
    actions,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }
}

/** Shows the approval dialog and resolves with a token only after the user presses Approve. */
export function askApproval(approvals: ApprovalHost, request: ApprovalRequest, extra: Pick<PendingApproval, 'checks' | 'confirm' | 'go'> = {}): Promise<ApprovalToken | null> {
  return new Promise((resolve, reject) => {
    set({
      approval: {
        requests: [request],
        ...extra,
        approve: async () => {
          set({ approval: null })
          try {
            await approvals.register(request)
            // The approve button of a card with `confirm` states it, so pressing it carries that answer.
            resolve(await grantApproval(approvals, request, Boolean(extra.confirm)))
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        },
        deny: async () => {
          set({ approval: null })
          try {
            await approvals.deny(request.id, 'Denied in the approval dialog')
          } finally {
            resolve(null)
          }
        },
      },
    })
  })
}

function connected(host: Host): { printers: PrinterHost; approvals: ApprovalHost } | null {
  return host.printers && host.approvals ? { printers: host.printers, approvals: host.approvals } : null
}

/** The plate's bounds in bed coordinates, for the preflight. */
function plateBoundsOf(st: AppState, bounds: (parts: PlateEntry['parts'], t: number[]) => { min: number[]; max: number[] } | null): { min: [number, number, number]; max: [number, number, number] } | null {
  let out: { min: [number, number, number]; max: [number, number, number] } | null = null
  for (const p of st.plate) {
    const b = bounds(p.parts, p.transform)
    if (!b) continue
    out = out ? { min: [0, 1, 2].map((i) => Math.min(out!.min[i]!, b.min[i]!)) as [number, number, number], max: [0, 1, 2].map((i) => Math.max(out!.max[i]!, b.max[i]!)) as [number, number, number] } : { min: [...b.min] as [number, number, number], max: [...b.max] as [number, number, number] }
  }
  return out
}

/**
 * Prints the sliced plate on a printer through the Print sheet (packages/app/src/send/print-sheet.tsx). The sheet is
 * the approval: it shows the file, the printer, the preflight result and the choices, and its confirm button is the
 * person's click. The token is granted on that click and bound to the
 * exact upload and start parameters. Remote, mimir, queued and scheduled starts keep the approval card.
 */
export async function sendToPrinter(host: Host, printer: PrinterInfo): Promise<void> {
  // Restart to update waits while a print is on its way (updates/updates.ts).
  const release = holdUpdates()
  try {
    await sendNow(host, printer)
  } finally {
    release()
  }
}

async function sendNow(host: Host, printer: PrinterInfo): Promise<void> {
  // A printer added without a connection gets the file to carry over instead.
  if (isExportOnly(printer)) return exportGcode(host)
  const conn = connected(host)
  const s = get().slice
  if (!conn) return
  if (s.status !== 'done') {
    toast('Slice the plate first')
    return
  }
  const unsafe = printBlock(get())
  if (unsafe) {
    toast(unsafe, 'error')
    return
  }
  const plateName = jobName(get())
  const status = await conn.printers.status(printer.id).catch(() => null)
  const specs = supportedOptions(printer, status)
  const ending = printEnding(printer.plugin)
  const st0 = get()
  const filaments = resolveSlots(st0).filter((r) => r.used).map((r) => ({ index: r.index, color: r.color, type: r.type }))
  // A printer that follows a slot map starts from the loaded slot of the same material and closest color; one that
  // does not takes filament N from slot N, which is what the sheet shows.
  const auto = ending === '.gcode.3mf' ? matchSlots(filaments, st0.printerSlots) : slotMapFor(filaments.map((f) => f.index), st0.printerSlots)
  const grams = s.result.stats.filamentG.reduce((a, b) => a + b, 0)
  const [{ bedStateFor, localPrintHost }, { preflight }, { bounds }] = await Promise.all([import('../send/bed-state'), import('../plate/preflight'), import('../plate/transform')])
  const bed = await bedStateFor(host, printer.id, status)
  // A Bambu Lab printer with Developer Mode off sends status but takes no print from here: the plate goes through
  // Bambu Connect (send/bambu-connect.ts). Any Bambu Lab printer offers it after a refusal too.
  const connectHow = printer.plugin === 'bambu-lan' ? (host.bambuConnect && !onLinux() ? 'open' as const : 'save' as const) : null
  const connectOnly = printRoute(printer, status) === 'bambu-connect'
  // The sheet opens at once with the estimate; the file is exported and checked while it is open.
  let check0: PrintSheetAsk['check'] = null
  let thumb0: string | undefined
  // The sheet as it opened, for opening it again after a refusal with the person's last choices kept.
  const sheetAsk = (): Omit<PrintSheetAsk, 'resolve'> => ({
    printer,
    status,
    plateName,
    specs,
    initial: mergeOptions(specs, get().sendChoices[printer.id]),
    name: withEnding(jobFileName(get(), s.result.fileName), ending),
    ending,
    filaments,
    slots: st0.printerSlots,
    auto,
    stats: { timeS: s.result.stats.timeS, grams, layers: s.result.layerCount },
    check: check0,
    ...(thumb0 ? { thumb: thumb0 } : {}),
    bed,
    ...(connectHow ? { bambuConnect: connectHow } : {}),
    ...(connectOnly ? { connectOnly } : {}),
  })
  const choice = new Promise<SendChoice | null>((resolve) => set({ printSheet: { ...sheetAsk(), resolve } }))
  const out = await exportPlateGcode(host, s.result.id)
  if (!out.blob) {
    set({ printSheet: null })
    toast('The slicer returned no G-code', 'error')
    return
  }
  const data = await out.blob.arrayBuffer()
  // A Bambu Lab printer gets the plate as a .gcode.3mf (export/actions.ts, printGcode3mf): the file it starts with
  // `project_file`, so it follows the slot choice. The hash the start is bound to is taken from the bytes that go
  // up, not from what the engine reported.
  const project = ending === '.gcode.3mf' ? await (await import('../export/actions')).printGcode3mf(new TextDecoder().decode(data)) : null
  const sent = project ? (project.buffer.slice(project.byteOffset, project.byteOffset + project.byteLength) as ArrayBuffer) : data
  const sha256 = await sha256Hex(sent)
  const st = get()
  const plateBounds = plateBoundsOf(st, bounds)
  // The config the plate was sliced with, filament slots included, so the material, nozzle and flow checks see what is in the file.
  const config = plateSliceConfig(st, st.plates.find((p) => p.id === st.activePlate)) as Record<string, SettingValue | undefined>
  // Preflight: the file against the printer as it is now (docs/safety.md). Shown in the sheet before the person decides.
  const checkFor = (name: string, hash = sha256) => preflight({ printer, status, config, plateBounds, plateBed: st.bed, file: { name, sha256: hash, layers: s.result.layerCount, timeS: s.result.stats.timeS, grams }, ...(s.result.collisions ? { collisions: s.result.collisions, objectNames: Object.fromEntries(st.plate.map((p) => [p.id, p.name])) } : {}) })
  const first = checkFor(withEnding(jobFileName(get(), s.result.fileName), ending))
  check0 = { errors: first.errors, warnings: first.warnings.map((text) => ({ text })), sha256 }
  // The plate's picture, from the thumbnails the engine wrote into the G-code.
  const shot = await import('../export/threemf').then((m) => m.gcodeThumbnails(new TextDecoder().decode(data.slice(0, 4_000_000)))).catch(() => [])
  const pic = shot.find((t) => t.w <= 300) ?? shot[shot.length - 1]
  if (pic) thumb0 = `data:image/png;base64,${btoa(Array.from(pic.png, (b) => String.fromCharCode(b)).join(''))}`
  set((cur) => (cur.printSheet ? { printSheet: { ...cur.printSheet, check: check0, ...(thumb0 ? { thumb: thumb0 } : {}) } } : {}))
  // The G-code lint (flow and temperature against the material) joins the warnings when it finishes.
  const types = [...new Set(filaments.map((f) => f.type).filter(Boolean))]
  // The engine held every move to the used filaments' max volumetric speed, so the lint checks against that.
  const mvs = config['filament_max_volumetric_speed']
  const caps = filaments.map((f) => Number(Array.isArray(mvs) ? mvs[f.index - 1] : mvs)).filter((v) => Number.isFinite(v) && v > 0)
  void import('../plate/lint')
    .then(({ sendWarnings }) => sendWarnings({ data, printers: conn.printers, printerId: printer.id, result: s.result, slots: Object.values(auto), ...(types.length === 1 && types[0] ? { material: types[0] } : {}), ...(caps.length ? { maxFlowMm3s: Math.max(...caps) } : {}) }))
    .then((lint) => {
      if (lint.length && check0) check0 = { ...check0, warnings: [...check0.warnings, ...lint] }
      if (lint.length) set((cur) => (cur.printSheet?.check ? { printSheet: { ...cur.printSheet, check: { ...cur.printSheet.check, warnings: [...cur.printSheet.check.warnings, ...lint] } } } : {}))
    })
    .catch(() => {})
  const plainSha = project ? await sha256Hex(data) : sha256
  const result = s.result
  let picked = await choice
  for (;;) {
    if (!picked) {
      toast('Nothing was sent')
      return
    }
    const outcome = await sendPicked(picked)
    if (outcome === 'done') return
    // The printer refused the .gcode.3mf. The sheet opens again with its reason in plain words. Sending the same
    // plate as plain G-code is the person's own choice there, never a fallback taken here.
    const reason = outcome.refused
    const last = picked
    picked = await new Promise<SendChoice | null>((resolve) =>
      set({ printSheet: { ...sheetAsk(), refusal: { reason, plainSha256: plainSha, last }, resolve } }),
    )
  }

  /** Sends one choice from the sheet. 'done' when it went (or failed in a way the toast already said), else the printer's refusal. */
  async function sendPicked(picked: SendChoice): Promise<'done' | { refused: string }> {
    if (picked.bambuConnect) return viaBambuConnect(picked)
    let opts: SendOptions = picked.options
    if (specs.length) set((cur) => ({ sendChoices: { ...cur.sendChoices, [printer.id]: Object.fromEntries(specs.map((sp) => [sp.id, Boolean(picked.options[sp.id])])) } }))
    // "Send as plain G-code" sends the G-code itself, under the same name with a .gcode ending.
    const plain = !project || picked.plainGcode === true
    const file: JobFile = plain ? { name: withEnding(picked.name, '.gcode'), kind: 'gcode', data, sha256: plainSha } : { name: picked.name, kind: 'gcode.3mf', data: sent, sha256 }
    const check = checkFor(file.name, file.sha256)
    if (check.errors.length) {
      toast(check.errors[0]!, 'error')
      return 'done'
    }
    // A slot map goes only to a printer that follows one for this file; the start options count filaments from 0.
    const fixedSlots = slotMapFor(usedSlots(get()), get().printerSlots)
    const follows = followsSlotMap(printer.plugin, file.name)
    if (follows && (picked.start || picked.queue)) {
      const slotMap = startSlotMap(picked.slotMap ?? fixedSlots)
      if (Object.keys(slotMap).length) opts = { ...opts, slotMap }
    }
    const start = picked.start
    const slotLine = slotMapLine(opts.slotMap) ?? (Object.keys(fixedSlots).length ? gcodeSlotsLine(fixedSlots) : null)
    const request = await buildApproval({
      tool: 'printer.send',
      permission: start ? 'start' : 'queue',
      title: start ? `Print ${plateName} on ${printer.name}?` : picked.queue ? `Upload ${plateName} to ${printer.name} and add it to the queue?` : `Send ${plateName} to ${printer.name} without starting it?`,
      lines: [
        ...check.facts,
        ...(start ? optionLines(specs, opts) : []),
        ...(start && slotLine ? [slotLine] : []),
        ...(start ? [bed === 'clear' ? 'The printer confirmed the bed is clear' : 'Confirmed on the Print sheet: the bed is clear and the right build plate is on it'] : []),
        start ? `Uploads ${file.name}, then heats and starts the printer` : picked.queue ? `Uploads ${file.name} to the printer and queues it${picked.queue.startAfter ? ` for after ${new Date(picked.queue.startAfter).toLocaleString()}` : ''}. It does not start on its own: you start it from the Printers page and approve again` : `Uploads ${file.name} to the printer. It does not start; you start it on the printer or from here later`,
      ],
      printerId: printer.id,
      actions: [
        { action: 'printer.upload' as const, target: printer.id, params: { printerId: printer.id, name: file.name, sha256: file.sha256 } },
        ...(start ? [{ action: 'printer.start' as const, target: printer.id, params: { printerId: printer.id, name: file.name, opts, sha256: file.sha256 } }] : []),
      ],
    })
    try {
      const hub = localPrintHost(host)
      if (start && hub) {
        // A hub starts a local print in one call, no card: the sheet's click was the approval, and it carried the bed statement when the hub asked for one.
        // Bambu Lab printers cannot list the objects of their print; the hub keeps the plate's so they can be skipped.
        const { plateObjectsFromGcode } = await import('../features/fleet/device')
        const objects = plateObjectsFromGcode(new TextDecoder().decode(data))
        const go = async (plateOk: boolean) => {
          await hub.printLocal(printer.id, file, opts, bed !== 'clear', objects.length ? objects : undefined, plateOk)
          toast(`${plateName} started on ${printer.name}`, 'ok')
          void rememberStartedUse(printer, file.name)
        }
        try {
          await go(false)
        } catch (e) {
          if ((e as { code?: unknown } | null)?.code !== 'plate_check') throw e
          // The camera guard saw something on the plate. Its card on the Printers tab shows the picture and can start
          // this same plate anyway.
          const { holdStart } = await import('../features/fleet/guard')
          holdStart(printer.id, () => go(true))
          toast(`${printer.name}: something is on the plate. The start is on hold on the Printers tab.`, 'warn')
        }
        return 'done'
      }
      // Other hosts: the click on the sheet's confirm button is the approval. Register the request it described and take its token.
      await conn!.approvals.register(request)
      // The sheet's confirm button is the approval and carried the bed statement when one was needed.
      const token = await grantApproval(conn!.approvals, request, start && bed !== 'clear')
      const remote = await conn!.printers.upload(printer.id, file, token)
      if (start) {
        await conn!.printers.start({ ...remote, sha256: remote.sha256 ?? file.sha256 }, opts, token)
        toast(`${plateName} started on ${printer.name}`, 'ok')
        void rememberStartedUse(printer, file.name)
      } else if (picked.queue) {
        const { addToQueue, queueId } = await import('../queue/queue')
        addToQueue({ id: queueId(), printerId: printer.id, printerName: printer.name, plateName, remote, sha256: file.sha256, layers: result.layerCount, timeS: result.stats.timeS, grams, options: opts, ...(picked.queue.startAfter ? { startAfter: picked.queue.startAfter } : {}), addedAt: new Date().toISOString() })
        toast(`${plateName} is queued for ${printer.name}. It has not started.`, 'ok')
      } else {
        toast(`${file.name} is on ${printer.name}. It has not started.`, 'ok')
      }
      return 'done'
    } catch (e) {
      const refused = refusalReason(e)
      if (refused !== null && !plain && start) return { refused }
      toast(e instanceof Error ? e.message : `Could not reach ${printer.name}`, 'error')
      return 'done'
    }
  }

  /** Opens the plate's .gcode.3mf in Bambu Connect, or saves it where that cannot happen, and says which in one line. */
  async function viaBambuConnect(picked: SendChoice): Promise<'done'> {
    const name = withEnding(picked.name, '.gcode.3mf')
    const check = checkFor(name)
    if (check.errors.length) {
      toast(check.errors[0]!, 'error')
      return 'done'
    }
    try {
      const handed = await handToBambuConnect(host, { name, data: sent }, plateName)
      const copy = handOffCopy(handed, appName())
      const link = copy.download
      toast(copy.text, copy.tone, link ? { label: 'Get Bambu Connect', run: () => void openLink(link) } : undefined)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not open Bambu Connect', 'error')
    }
    return 'done'
  }
}

/** The printer's own reason when an error is a refused start (`refused`), else null. */
export function refusalReason(e: unknown): string | null {
  if (!e || typeof e !== 'object' || (e as { code?: unknown }).code !== 'refused') return null
  const m = e instanceof Error ? e.message : String((e as { message?: unknown }).message ?? '')
  const at = m.indexOf('refused the print: ')
  return (at >= 0 ? m.slice(at + 'refused the print: '.length) : m).trim() || 'The printer gave no reason.'
}

/** Starts a queued plate: the same approval card and bed-clear question as a send, on the file already on the printer. */
export async function startQueued(host: Host, item: QueueItem): Promise<void> {
  const release = holdUpdates()
  try {
    await startQueuedNow(host, item)
  } finally {
    release()
  }
}

async function startQueuedNow(host: Host, item: QueueItem): Promise<void> {
  const conn = connected(host)
  if (!conn) return
  const { removeFromQueue } = await import('../queue/queue')
  const status = await conn.printers.status(item.printerId).catch(() => null)
  if (status && status.state !== 'idle' && status.state !== 'finished') {
    toast(`${item.printerName} is busy. Start it when the printer is free.`, 'warn')
    return
  }
  // Queue items from before the slot map contract hold 1 based keys on plain G-code. No printer follows a map
  // for those files, so the start goes without one and the card says what the printer will do.
  const info = (await Promise.resolve().then(() => conn.printers.list()).catch(() => [] as PrinterInfo[])).find((p) => p.id === item.printerId)
  const options = info && followsSlotMap(info.plugin, item.remote.name) ? item.options : withoutSlotMap(item.options)
  const request = await buildApproval({
    tool: 'printer.start',
    permission: 'start',
    title: `Start ${item.plateName} on ${item.printerName}?`,
    lines: [
      `${item.printerName}: ${item.remote.name}`,
      `${item.layers} layers, ${formatDuration(item.timeS)}, ${item.grams.toFixed(1)} g`,
      `File check: ${item.sha256.slice(0, 12)}`,
      ...[slotMapLine(options.slotMap)].filter((l): l is string => l !== null),
      'Heats and starts the printer',
    ],
    printerId: item.printerId,
    actions: [{ action: 'printer.start' as const, target: item.printerId, params: { printerId: item.printerId, name: item.remote.name, opts: options, sha256: item.remote.sha256 ?? item.sha256 } }],
  })
  try {
    const token = await askApproval(conn.approvals, request, { confirm: 'The bed is clear and the right build plate is on it', go: 'Bed is clear, start print' })
    if (!token) return
    await conn.printers.start({ ...item.remote, sha256: item.remote.sha256 ?? item.sha256 }, options, token)
    removeFromQueue(item.id)
    toast(`${item.plateName} started on ${item.printerName}`, 'ok')
  } catch (e) {
    toast(e instanceof Error ? e.message : `Could not reach ${item.printerName}`, 'error')
  }
}

/** Remembers what a started plate will use, so the print's finish can offer the Spoolman subtraction. */
async function rememberStartedUse(printer: PrinterInfo & { status?: PrinterStatus }, jobName: string): Promise<void> {
  const s = get()
  if (s.slice.status !== 'done' || !s.spools?.length) return
  const { rememberUse, usesFor } = await import('../inventory/usage')
  const uses = usesFor(s.slice.result.stats.filamentG, s.spools, s.spoolLinks, printer.status?.slots.map((x) => x.spoolmanId))
  rememberUse({ printerId: printer.id, jobName, uses })
}

/** Subtracts what a slice used from the Spoolman spools linked to its slots. One approval covers every spool and amount listed. */
export async function recordSpoolUse(host: Host, uses: { spoolId: number; label: string; grams: number }[]): Promise<void> {
  const conn = connected(host)
  if (!conn || uses.length === 0) return
  const inputs = uses.map((u) => ({ id: u.spoolId, grams: Math.round(u.grams * 10) / 10 }))
  const request = await buildApproval({
    tool: 'spoolman.record_usage',
    permission: 'profile',
    title: 'Subtract this print from your spools in Spoolman?',
    lines: uses.map((u) => `${u.label}: ${u.grams.toFixed(1)} g`),
    actions: inputs.map((input) => ({ action: 'plugin.call' as const, target: 'spoolman', params: { pluginId: 'spoolman', tool: 'record_usage', input } })),
  })
  try {
    const token = await askApproval(conn.approvals, request)
    if (!token) return
    for (const input of inputs) await conn.printers.callTool('spoolman', 'record_usage', input, token)
    const { loadSpools } = await import('../inventory/spools')
    await loadSpools(host)
    toast('Spools updated in Spoolman', 'ok')
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not reach Spoolman', 'error')
  }
}

export async function printerAction(host: Host, printer: PrinterInfo, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  const conn = connected(host)
  if (!conn) return
  const verb = action === 'pause' ? 'Pause' : action === 'resume' ? 'Resume' : 'Cancel'
  const request = await buildApproval({
    tool: `printer.${action}`,
    permission: 'start',
    title: `${verb} the print on ${printer.name}?`,
    lines: [`${printer.name}: ${printer.vendor} ${printer.model}`, action === 'cancel' ? 'The job stops and cannot be resumed' : action === 'pause' ? 'The printer parks the head and holds temperatures' : 'The printer reheats and continues the job'],
    printerId: printer.id,
    actions: [{ action: `printer.${action}`, target: printer.id, params: { printerId: printer.id } }],
  })
  try {
    const token = await askApproval(conn.approvals, request)
    if (!token) return
    await conn.printers[action](printer.id, token)
    toast(`${action === 'pause' ? 'Paused' : action === 'resume' ? 'Resumed' : 'Canceled'} on ${printer.name}`, 'ok')
  } catch (e) {
    toast(e instanceof Error ? e.message : `Could not reach ${printer.name}`, 'error')
  }
}

/**
 * The layer range a new slice shows. An ordinary slice starts at the full stack. A slice that replaces one after a
 * change made from Preview (norn) keeps the layer being looked at, clamped if the stack got shorter.
 */
export function layersAfterSlice(prev: { layerHi: number; layerLo: number; moveCut: number }, layerCount: number, keep: boolean): { layerHi: number; layerLo: number; moveCut: number } {
  if (!keep || prev.layerHi < 1) return { layerHi: layerCount, layerLo: 1, moveCut: 1 }
  const hi = Math.max(1, Math.min(prev.layerHi, layerCount))
  return { layerHi: hi, layerLo: Math.max(1, Math.min(prev.layerLo, hi)), moveCut: prev.moveCut }
}
