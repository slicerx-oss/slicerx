// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// User actions that touch the host: loading models, slicing, export, sending
// to a printer. Commands, buttons and Pilot tools all call these.
import { engineErrorText } from '../lib/engine-errors'
import { isGcodeName, openGcodeRef } from '../workspaces/preview/gcode-file'
import type { ApprovalHost, ApprovalRequest, ApprovalToken, FileRef, Host, LayerGcode, PermissionClass, PlateObject, PrintConfig, PrinterInfo, SideEffectAction, SlicerHost } from '@slicerx/contracts'
import { grantApproval, hashParams, readPreview } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { DEFAULT_MODEL, demoModel } from '../lib/demo-models'
import { noteSliceTiming, plateTriangles } from './slice-estimate'
import { defaultColorMode } from '../lib/preview-stats'
import type { DecodedModel } from '@slicerx/embed/mesh'
import { resumeSliceOptions } from '../geom/resume'
import { slotConfig, slotOverridesFor } from '../filament/slots'
import type { QueueItem } from '../queue/queue'
import { requestVolumes } from '../plate/volumes'
import { areaOrigin, objectToMachine, towerToPlate } from '../plate/bed-origin'
import { sliceHandle, sliceShards } from '../plate/painted'
import { nameOptions, plateConfig } from '../plate/plates'
import { bedTypeConfig } from '../plate/bed-type'
import { plateSequence } from '../plate/plate-sequence'
import { layerHeightConflict, objectOverrides, partOverridesOf } from '../plate/object-settings'
import { clearProject } from '../project/new'
import { beginOpen, confirmDiscard, markClean, OpenSuperseded, type OpenScope } from '../project/unsaved'
import { markOpenEnded, markOpenStage, markOpenStarted } from '../lib/open-mark'
import { sliceStage, sliceStarted } from '../lib/slice-timing'
import { colorModeAfterSlice, fullPlate, get, markStale, set, shownSlice, toast, type AppState, type PlateEntry, type PlateMeta, selectedIds, type PendingApproval, type ModelSource } from './store'
import { brandAccent } from '../edition'


let sliceAbort: AbortController | null = null
let seq = 0
export const uid = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`

export function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** Places the object at the bed center; models are stored centered on X and Y. */
function centered(bedW: number, bedD: number): number[] {
  const t = identity()
  t[12] = bedW / 2
  t[13] = bedD / 2
  return t
}

// Designs opened this session (a file, a Vault design, an example picked by hand), and whether the example plate
// was put out at the start.
let opened = 0
let seeded = false

async function addDecoded(host: Host, model: DecodedModel, opts: { replace: boolean; thumb?: string; keep?: () => boolean; scope?: OpenScope | undefined }): Promise<PlateEntry | null> {
  const handle = await host.slicer.loadParts(model.name, model.parts)
  if (opts.keep && !opts.keep()) return null
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
  const add = () => set((s) => ({ plate: opts.replace ? [entry] : [...s.plate, entry], selection: entry.id }))
  if (opts.scope) opts.scope.run(add)
  else add()
  markStale()
  return entry
}

/** Puts one of the built-in example models on the plate. */
export async function loadDemoModel(host: Host, slug: string, opts: { replace?: boolean; keep?: () => boolean } = {}): Promise<void> {
  const demo = demoModel(slug)
  if (!demo) {
    toast(`No example model called ${slug}`, 'error')
    return
  }
  // Picked by hand, it is an opened design; the start of session example passes `keep`.
  if (!opts.keep) opened++
  set({ plateLoading: true })
  try {
    const { parts, colors } = await demo.build()
    const model: DecodedModel = { name: demo.name, bboxMm: [0, 0, 0], triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), parts, colors, offset: [0, 0, 0] }
    const added = await addDecoded(host, model, { replace: opts.replace ?? true, ...(opts.keep ? { keep: opts.keep } : {}) })
    if (added && (opts.replace ?? true)) {
      set({ slice: { status: 'idle' }, preview: null, projectFile: null })
      markClean()
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not load the model', 'error')
  } finally {
    set({ plateLoading: false, sliceDuringOpen: false })
  }
}

/** The example plate. */
export function loadDefaultPlate(host: Host): Promise<void> {
  return loadDemoModel(host, DEFAULT_MODEL, { replace: true })
}

/**
 * The example a fresh session starts with: once, never after a design was opened, and dropped if a design opens while
 * it loads. A plate the person emptied stays empty.
 */
export function seedExamplePlate(host: Host): Promise<void> {
  if (seeded || opened > 0) return Promise.resolve()
  seeded = true
  return loadDemoModel(host, DEFAULT_MODEL, { replace: true, keep: () => opened === 0 })
}

/** Open (the default) starts a new project with the files; `fresh: false` is Add model, onto the plate as it is. */
export async function openModelFiles(host: Host, opts: { fresh?: boolean } = {}): Promise<void> {
  const refs = await host.files.open({ accept: ['.stl', '.3mf', '.sx3mf', '.sxlock', '.obj', '.amf', '.step', '.stp', '.json', '.gcode'], multiple: true })
  await addFileRefs(host, refs, { fresh: opts.fresh ?? true })
}

/** A new project for an opened design: asks about unsaved work first (Save, Discard, Cancel). False when canceled. */
async function startFresh(): Promise<boolean> {
  opened++
  if (!(await confirmDiscard('open another design'))) return false
  // loading first, so the 3D view holds the old scene through the clear until the new model draws
  set({ plateLoading: true })
  clearProject()
  return true
}

/** Returns true when it already told the person what it did (a toast of its own). */
async function addBytes(host: Host, name: string, data: ArrayBuffer, scope?: OpenScope): Promise<boolean> {
  if (/\.(stl|obj|amf|step|stp)$/i.test(name)) {
    // Every mesh goes through the engine: repaired, unit detected, loose bodies split. STEP files are
    // meshed first in a worker of their own.
    const { addAutoImport } = await import('./import-auto')
    try {
      await addAutoImport(host, name, data, undefined, undefined, scope)
    } catch (e) {
      // Without the engine (a host that has none) an STL still opens, unrepaired.
      if (!/\.stl$/i.test(name)) throw e
      const { decodeStl } = await import('@slicerx/embed/mesh')
      try {
        await addDecoded(host, decodeStl(data, name), { replace: false, scope })
      } catch {
        throw e
      }
      return false
    }
    return true
  } else if (/\.json$/i.test(name)) {
    const { decodeQuantized } = await import('@slicerx/embed/mesh')
    const json: unknown = JSON.parse(new TextDecoder().decode(data))
    await addDecoded(host, decodeQuantized(json), { replace: false, scope })
  } else {
    // A project with objects, parts and volumes opens as such.
    // The project reader loads with the first project, not with the app.
    const opened = await (await import('./open-project')).addProject(host, data, name, scope)
    if (opened) return opened === 'told'
    // 3MF geometry for the viewport arrives with the core's mesh export; slice it meanwhile.
    const handle = await host.slicer.loadModel(data, name)
    // A Vault design stays one when the engine opens it.
    const source = await (await import('../export/import3mf')).vaultSourceOf(new Uint8Array(data))
    const { bed } = get()
    const add = () =>
      set((s) => ({
        plate: [...s.plate, { id: uid('obj'), name: handle.name, handle, parts: [], colors: handle.parts.map((p) => p.color ?? brandAccent()), transform: centered(bed.widthMm, bed.depthMm), ...(source ? { source } : {}) }],
      }))
    if (scope) scope.run(add)
    else add()
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
  // A new project ends clean, unless the person edited it while it opened.
  const scope = opts.fresh ? beginOpen() : undefined
  markOpenStarted(name)
  markOpenStage('read')
  set({ plateLoading: true })
  try {
    const before = new Set(get().plate.map((p) => p.id))
    const told = await addBytes(host, name, data, scope)
    // A model from the library keeps its model and creator ids for the sx3mf it is saved in.
    if (source && (source.modelId || source.creatorId)) {
      const tag = () => set((s) => ({ plate: s.plate.map((p) => (before.has(p.id) ? p : { ...p, source })) }))
      if (scope) scope.run(tag)
      else tag()
    }
    scope?.run(() => undefined)
    scope?.finish()
    if (!told) toast(`Added ${name}`)
  } catch (e) {
    scope?.finish(false)
    // A newer open took over: it says what it opened.
    if (e instanceof OpenSuperseded) return
    toast(e instanceof Error ? e.message : `Could not open ${name}`, 'error')
  } finally {
    if (!scope?.superseded) {
      set({ plateLoading: false, sliceDuringOpen: false })
      markOpenEnded()
    }
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
  // A new project, or a project onto an empty plate, ends clean, unless the person edited it while it opened.
  const scope = opts.fresh || (project && wasEmpty) ? beginOpen() : undefined
  markOpenStarted(refs.length === 1 ? (refs[0]?.name ?? '') : `${refs.length} files`)
  set({ plateLoading: true })
  try {
    let told = false
    for (const ref of refs) {
      const open = unlocked.get(ref)
      const name = open?.name ?? ref.name
      const data = open?.data ?? (await host.files.read(ref))
      markOpenStage('read')
      // A copy is taken first: a worker may take the original. A locked project is never kept unlocked in recents.
      const keep = !open && /\.(sx3mf|3mf)$/i.test(name) ? data.slice(0) : null
      told = (await addBytes(host, name, data, scope)) || told
      if (keep) void import('../project/autosave').then((m) => m.recordRecent(name, keep))
    }
    scope?.run(() => undefined)
    if (project && wasEmpty) {
      // Save writes back to an opened .sx3mf; another slicer's 3MF is saved as a new file.
      const only = refs.length === 1 ? refs[0] : undefined
      set({ projectFile: only?.path && /\.sx3mf$/i.test(only.name) ? only : null })
    }
    scope?.finish()
    if (scope && !scope.superseded) set((s) => ({ jobSeq: s.jobSeq + 1 }))
    if (!told || refs.length > 1) toast(refs.length === 1 ? `Added ${refs[0]?.name ?? 'model'}` : `Added ${refs.length} models`)
  } catch (e) {
    scope?.finish(false)
    // A newer open took over: it says what it opened.
    if (e instanceof OpenSuperseded) return
    toast(e instanceof Error ? e.message : 'Could not open the file')
  } finally {
    if (!scope?.superseded) {
      set({ plateLoading: false, sliceDuringOpen: false })
      markOpenEnded()
    }
  }
}

export function removeSelected(): void {
  const ids = new Set(selectedIds())
  if (ids.size === 0) return
  const { plate } = get()
  set({ plate: plate.filter((p) => !ids.has(p.id)), selection: null, selectedIds: [] })
  markStale()
}

/**
 * Clears the plate for the next job: every plate, the project's printer and the settings it brought go with the
 * objects, as a new project does, so nothing of the old job reaches the next file.
 */
export function clearPlate(): void {
  clearProject()
}

function overridesOf(meta: PlateMeta | undefined, p: PlateEntry): { slotOverrides?: Record<string, number> } {
  const o = slotOverridesFor(meta, p)
  return o ? { slotOverrides: o } : {}
}

/** The resolved config a plate slices with: profile and Easy choices, overrides, filament slots and the plate's own settings. */
export function plateSliceConfig(s: AppState, meta: PlateMeta | undefined): PrintConfig {
  const base = resolveConfig(s.easy, s.overrides)
  // The plate type picks the bed temperatures (the engine's curr_bed_type), so it goes with the plate's other settings.
  return { ...base, ...slotConfig(s), ...plateConfig(meta), ...bedTypeConfig(meta, base) } as PrintConfig
}

/**
 * The engine's objects for a plate's printable entries: placement, slot overrides, volumes, object and part settings and
 * brim ears. A painted object goes to the engine as its parts with their paint, and slices with that mesh's handle.
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
  const timed = sliceStarted(opts.auto === true)
  // The printer, filament and process layer must match the printer and quality tier before the configuration is read.
  await (await import('./profile-sync')).profileReady()
  // A project's own printer G-code waits for the person: a slice they start asks first, a background slice uses the
  // profile's until they choose.
  if (!opts.auto && get().projectGcode && get().plate.length > 0) {
    if ((await (await import('./project-gcode')).askProjectGcode()) === null) return
  }
  // A history step open for editing shows the part as it was before it; the slice is of the whole part.
  const at = get()
  const s = at.historyEdit ? { ...at, plate: fullPlate(at) } : at
  if (s.plate.length === 0) {
    if (!opts.auto) toast('Add a model to the plate first')
    return
  }
  if (s.plate.every((p) => p.printable === false)) {
    if (!opts.auto) toast('Every object on this plate is set not to print. Turn one on first.')
    return
  }
  sliceStage(timed, 'ready')
  const base = resolveConfig(s.easy, s.overrides)
  const seqNow = plateSequence(s.plates.find((p) => p.id === s.activePlate), base)
  const plateLayer = base['layer_height']
  const conflict = layerHeightConflict(s, seqNow, typeof plateLayer === 'number' ? plateLayer : 0.2)
  if (conflict) {
    set({ slice: { status: 'error', message: conflict }, preview: null })
    return
  }
  sliceAbort?.abort()
  const abort = new AbortController()
  sliceAbort = abort
  // The last slice stays on screen, stale, until this one lands: the panels and the preview never empty in between.
  const before = shownSlice(get().slice)
  set({ slice: { status: 'running', progress: null, startedAt: performance.now(), ...(before ? { last: before.result } : {}) } })
  let again = false
  try {
    // The plate's own print sequence (Bambu Studio and Orca set it per plate).
    const meta = s.plates.find((p) => p.id === s.activePlate)
    const config = plateSliceConfig(s, meta)
    const toPrint = s.plate.filter((p) => p.printable !== false)
    const objects = await plateObjects(host.slicer, s, meta, s.plate)
    if (abort.signal.aborted) throw new DOMException('Slice canceled', 'AbortError')
    sliceStage(timed, 'objects')
    // sleipnir plans the layer tops; a calibration plate keeps its own height bands.
    // Vary layer height reaches the engine as the resolved `smart_layer` mode (quality, or strength for a strong print).
    const smart = (String((config as Record<string, unknown>)['smart_layer'] ?? 'off') as 'off' | 'quality' | 'strength')
    // A slice canceled while its plan runs goes no further; the plan stops unless the next slice takes it over.
    const planned = smart !== 'off' && !s.calibration[s.activePlate] ? await (await import('../plate/smart-layer')).planSmartLayers(toPrint, config, smart, abort.signal).catch(() => null) : null
    abort.signal.throwIfAborted()
    // A project's settings by height: range keys by object, and layer height ranges as the plate's layer tops.
    const { heightRangesOf, rangeLayerTops } = await import('../plate/layer-ranges')
    const cfg = config as Record<string, unknown>
    const rangeTops = smart === 'off' && !s.calibration[s.activePlate] ? rangeLayerTops(toPrint, Number(cfg['initial_layer_print_height'] ?? 0.2), Number(cfg['layer_height'] ?? 0.2)) : null
    const heightRanges = [...(s.calibration[s.activePlate]?.ranges ?? []), ...heightRangesOf(toPrint)]
    // A resume plan restarts the failed job's layers, so its layer tops win over a fresh plan.
    const layerTopsMm = s.resume?.layerTopsMm?.length ? s.resume.layerTopsMm : (planned ?? rangeTops)
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
          options: { emitGcode: true, emitPreview: true, shards: sliceShards(host, toPrint), ...trustOptions(s), ...nameOptions(s), ...(s.profile?.printerId ? { printerId: s.profile.printerId } : {}), ...(layerTopsMm ? { layerTopsMm } : {}), ...(heightRanges.length ? { heightRanges } : {}), ...(layerGcode.length ? { layerGcode } : {}), ...(s.resume ? resumeSliceOptions(s.resume.plan, s.resume.declareZ) : {}) },
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
    sliceStage(timed, 'request')
    const sliced = await sliceWith()
    if (sliceAbort !== abort) return
    // A slice canceled as it finished is still canceled: its plate may be gone.
    if (abort.signal.aborted) throw new DOMException('Slice canceled', 'AbortError')
    // How long this plate took, for the next slice's size estimate (slice-estimate.ts).
    noteSliceTiming(s.activePlate, { triangles: plateTriangles(toPrint), ms: sliced.wallMs })
    sliceStage(timed, 'result', { ...(sliced.engineWallMs !== undefined ? { engineMs: sliced.engineWallMs } : {}), engineCpuMs: Object.values(sliced.stageMicros ?? {}).reduce((n: number, us) => n + (us ?? 0), 0) / 1000 })
    // The tower comes back in machine coordinates; the plate counts from its corner.
    const result = sliced.primeTower ? { ...sliced, primeTower: towerToPlate(sliced.primeTower, areaOrigin(config['printable_area'])) } : sliced
    const raw = await host.slicer.getPreview(result.id)
    if (abort.signal.aborted) throw new DOMException('Slice canceled', 'AbortError')
    sliceStage(timed, 'preview', { previewBytes: raw.byteLength })
    const preview = readPreview(raw)
    sliceStage(timed, 'parsed')
    const cur = get()
    set((st) => ({ slicesDone: st.slicesDone + 1 }))
    set({ slice: { status: 'done', result, stale: false }, sliceHeld: false, preview, strikePick: null, strikeJump: null, strikeHover: null, ...layersAfterSlice(cur, preview.layerCount, cur.norn.before !== null), ...colorModeAfterSlice(cur, defaultColorMode(preview)) })
    sliceStage(timed, 'shown')
    markOpenStage('sliced')
  } catch (e) {
    if (abort.signal.aborted) {
      // A newer slice may already be running; its state is not ours to reset.
      if (sliceAbort === abort) {
        const cur = get().slice
        set({ slice: cur.status === 'running' && cur.last ? { status: 'done', result: cur.last, stale: true } : { status: 'idle' } })
      }
      return
    }
    const message = engineErrorText(e instanceof Error ? e.message : String(e))
    if (await dropRefusedProjectSetting(message)) again = true
    else {
      // A refused slice (off the bed, in an excluded area) must not leave the last slice's toolpaths looking current.
      set({ slice: { status: 'error', message }, preview: null })
      if (!opts.auto) toast(message, 'error')
    }
  } finally {
    if (sliceAbort === abort) sliceAbort = null
  }
  // Each round drops one key the file brought, so this ends.
  if (again) await slicePlate(host, opts)
}

/**
 * A setting an opened project brought that the engine refuses (Bambu Studio's -1 for "auto" where we have no such
 * value, say) is dropped, so the plate slices with the profile's value. True when it dropped one.
 */
async function dropRefusedProjectSetting(message: string): Promise<boolean> {
  const brought = get().projectSettings
  if (!brought) return false
  const { entryWithout, refusedSetting } = await import('../export/project-settings')
  const refused = refusedSetting(message)
  if (!refused || !brought.keys.includes(refused.key)) return false
  const { key, reason } = refused
  set((s) => ({
    overrides: Object.fromEntries(Object.entries(s.overrides).filter(([k]) => k !== key)),
    plate: s.plate.map((e) => entryWithout(e, key)),
    plates: s.plates.map((p) => ({ ...p, objects: p.objects.map((e) => entryWithout(e, key)) })),
    projectSettings: { ...brought, keys: brought.keys.filter((k) => k !== key) },
  }))
  const { settingDef } = await import('@slicerx/settings')
  toast(`Setting not imported from ${brought.source}: ${settingDef(key)?.label ?? key} (${reason}). Using your profile's value.`, 'warn')
  return true
}

export function cancelSlice(opts: { quiet?: boolean } = {}): void {
  if (sliceAbort) {
    sliceAbort.abort()
    if (!opts.quiet) toast('Slice canceled')
  }
}

/** Whether a slice is in flight. */
export const slicing = (): boolean => sliceAbort !== null

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

/** What Export and Print say when the slice on screen is from before the plate changed. */
export const STALE_SLICE = 'The plate changed after this slice. Slice it again first.'

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

/**
 * The layer range a new slice shows. An ordinary slice starts at the full stack. A slice that replaces one after a
 * change made from Preview (norn) keeps the layer being looked at, clamped if the stack got shorter.
 */
export function layersAfterSlice(prev: { layerHi: number; layerLo: number; moveCut: number }, layerCount: number, keep: boolean): { layerHi: number; layerLo: number; moveCut: number } {
  if (!keep || prev.layerHi < 1) return { layerHi: layerCount, layerLo: 1, moveCut: 1 }
  const hi = Math.max(1, Math.min(prev.layerHi, layerCount))
  return { layerHi: hi, layerLo: Math.max(1, Math.min(prev.layerLo, hi)), moveCut: prev.moveCut }
}

/** The printer's own reason when an error is a refused start (`refused`), else null. */
export function refusalReason(e: unknown): string | null {
  if (!e || typeof e !== 'object' || (e as { code?: unknown }).code !== 'refused') return null
  const m = e instanceof Error ? e.message : String((e as { message?: unknown }).message ?? '')
  const at = m.indexOf('refused the print: ')
  return (at >= 0 ? m.slice(at + 'refused the print: '.length) : m).trim() || 'The printer gave no reason.'
}

/** The send and printer flow loads on first use, so the startup shell stays small (send-actions.ts). */
const sendActions = () => import('./send-actions')

export async function exportGcode(host: Host): Promise<void> {
  return (await sendActions()).exportGcode(host)
}

export async function sendToPrinter(host: Host, printer: PrinterInfo): Promise<void> {
  return (await sendActions()).sendToPrinter(host, printer)
}

export async function startQueued(host: Host, item: QueueItem): Promise<void> {
  return (await sendActions()).startQueued(host, item)
}

export async function recordSpoolUse(host: Host, uses: { spoolId: number; label: string; grams: number }[]): Promise<void> {
  return (await sendActions()).recordSpoolUse(host, uses)
}

export async function printerAction(host: Host, printer: PrinterInfo, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  return (await sendActions()).printerAction(host, printer, action)
}
