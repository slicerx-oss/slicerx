// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slicing a plate: the configuration and objects the engine gets, and the run itself. It loads the first time a plate
// slices (actions.ts slicePlate), so the startup shell stays small.
import { engineErrorText } from '../lib/engine-errors'
import type { Host, LayerGcode, PlateObject, PrintConfig, SliceRequest, SliceWarning, SlicerHost } from '@slicerx/contracts'
import { isNoLocalEngine, readPreview } from '@slicerx/contracts'
import { scriptKeyValues } from '@slicerx/settings/script-keys'
import { resolveConfig } from '../adapters/config'
import { noteSliceTiming, plateTriangles } from './slice-estimate'
import { defaultColorMode } from '../lib/preview-stats'
import { resumeSliceOptions } from '../geom/resume'
import { slotOverridesFor } from '../filament/slots'
import { slotConfig } from '../filament/slot-config'
import { requestVolumes } from '../plate/volumes'
import { areaOrigin, objectToMachine, towerToPlate } from '../plate/bed-origin'
import { sliceHandle, sliceShards } from '../plate/painted'
import { nameOptions, plateConfig } from '../plate/plates'
import { bedTypeConfig } from '../plate/bed-type'
import { objectOverrides, partOverridesOf, plateLayerHeightConflict, smartLayerWarning, towerPrints } from '../plate/object-settings'
import { mixedNozzleConfig } from '../filament/object-nozzle'
import { markOpenStage } from '../lib/open-mark'
import { sliceStage, sliceStarted } from '../lib/slice-timing'
import { colorModeAfterSlice, fullPlate, get, set, shownSlice, toast, type AppState, type PlateEntry, type PlateMeta } from './store'
import { beginSlice, currentSlice, endSlice, engineSlice, layersAfterSlice, trustOptions } from './actions'
import { hostSlices } from './model-mode'
import { activeResume, outputKey, planFor, RESUME_VOID, resumeVoid, sliceInputsKey, sliceStamp, sliceState, storedResumeTops } from '../plate/resume-tops'

function overridesOf(meta: PlateMeta | undefined, p: PlateEntry): { slotOverrides?: Record<string, number> } {
  const o = slotOverridesFor(meta, p)
  return o ? { slotOverrides: o } : {}
}

/** The resolved config a plate slices with: profile and Easy choices, overrides, filament slots and the plate's own settings. */
export function plateSliceConfig(s: AppState, meta: PlateMeta | undefined): PrintConfig {
  const base = resolveConfig(s.easy, s.overrides)
  // The plate type picks the bed temperatures (the engine's curr_bed_type), so it goes with the plate's other settings.
  const config = { ...base, ...slotConfig(s, meta?.id), ...plateConfig(meta), ...bedTypeConfig(meta, base) } as Record<string, unknown>
  // Nozzles of different sizes: the map goes by hand, and a prime tower keeps one layer height.
  const sliced = { ...config, ...mixedNozzleConfig(s, meta, config, towerPrints(s, meta, config)) }
  // A key no setting models that the plate's printer G-code names: the opened project's value, as the engine renders
  // the script from the file in sx slice <project.3mf>.
  return (s.projectScriptKeys ? { ...sliced, ...scriptKeyValues(sliced, s.projectScriptKeys) } : sliced) as PrintConfig
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
 * The request a plate slices with, and what the slice notes beside it: the objects, the resolved settings and the layer
 * plan (a resume's stored tops, the plate's own layer heights, sleipnir's plan or height ranges), with the resume's
 * options when `s.resume` is set. `onObjects` runs once the objects are ready.
 */
export async function plateSliceRequest(
  host: Host,
  s: AppState,
  signal: AbortSignal,
  onObjects?: () => void,
): Promise<{ request: SliceRequest; toPrint: PlateEntry[]; config: PrintConfig; replaces: SliceWarning | null; skippedTools: SliceWarning[] }> {
  // The plate's own print sequence (Bambu Studio and Orca set it per plate).
  const meta = s.plates.find((p) => p.id === s.activePlate)
  const config = plateSliceConfig(s, meta)
  const toPrint = s.plate.filter((p) => p.printable !== false)
  const objects = await plateObjects(host.slicer, s, meta, s.plate)
  if (signal.aborted) throw new DOMException('Slice canceled', 'AbortError')
  onObjects?.()
  // sleipnir plans the layer tops; a calibration plate keeps its own height bands.
  // Vary layer height reaches the engine as the resolved `smart_layer` mode (quality, or strength for a strong print).
  const smart = (String((config as Record<string, unknown>)['smart_layer'] ?? 'off') as 'off' | 'quality' | 'strength')
  // A slice canceled while its plan runs goes no further; the plan stops unless the next slice takes it over.
  // The plate's own layer heights (the layer height editor) replace sleipnir's plan and the fixed layer height.
  const profile = !s.calibration[s.activePlate] && meta?.settings.layerProfile?.length ? meta.settings.layerProfile : null
  const own = profile ? (await import('../plate/layer-profile')).plateProfileTops(profile, toPrint, config) : null
  const planned = !own && smart !== 'off' && !s.calibration[s.activePlate] ? await (await import('../plate/smart-layer')).planSmartLayers(toPrint, config, smart, signal).catch(() => null) : null
  signal.throwIfAborted()
  // A resume plan restarts the failed job's layers, so its layer tops win over a fresh plan. Those tops are the
  // layers the job printed, so they go as exact and as sliced: the engine keeps them as given, not stretched again
  // for a Z shrinkage. A resume with no stored tops slices the plate's own, which stretch as in the job. Stored tops
  // hold only for the plate they were planned on, as it was then (storedResumeTops).
  // A resume plan holds as one: its layers, the layer it starts from and the height it declares, or none of them.
  const resume = activeResume(s)
  const stored = storedResumeTops(s)
  const layerTopsMm = stored ?? own ?? planned
  // The engine warns about layer heights objects set for themselves only when it plans the layers; these tops are the app's.
  const replaces = planned && layerTopsMm === planned ? smartLayerWarning(s) : own && layerTopsMm === own ? smartLayerWarning(s, "This plate's own layer heights") : null
  // A project's settings by height: range keys by object, and with no other plan, the layer heights by height the
  // engine plans the plate's layers from.
  const { heightRangesOf } = await import('../plate/layer-ranges')
  const byRanges = smart === 'off' && !s.calibration[s.activePlate] && !layerTopsMm
  const heightRanges = [...(s.calibration[s.activePlate]?.ranges ?? []), ...heightRangesOf(toPrint, { layerHeights: byRanges })]
  // Marks from the layer slider (pause, color change, custom G-code) go by height: the engine places them on its own
  // layers, so a plate whose layer plan only the engine knows (sleipnir color bands) slices once.
  const marks = get().layerMarks[s.activePlate] ?? []
  const calibGcode = s.calibration[s.activePlate]?.layerGcode ?? []
  const markTools = marks.length ? await import('../plate/layer-marks') : null
  const layerGcode: LayerGcode[] = [...calibGcode, ...(markTools ? markTools.layerGcodeByHeight(marks) : [])]
  // A project's tool changes by height go to the engine, which notes those that do not apply to the plate; those the
  // file saved for a plate of several filaments are noted here in the same words.
  const toolChanges = markTools ? markTools.toolChangesByHeight(marks) : []
  const skippedTools = markTools ? markTools.skippedToolChanges(marks) : []
  const request: SliceRequest = {
    plate: {
      bed: s.bed,
      objects,
    },
    config,
    options: { emitGcode: true, emitPreview: true, previewFormat: 'v2', shards: sliceShards(host, toPrint), ...trustOptions(s), ...nameOptions(s), ...(s.profile?.printerId ? { printerId: s.profile.printerId } : {}), ...(layerTopsMm ? { layerTopsMm } : {}), ...(layerTopsMm && (layerTopsMm === own || layerTopsMm === stored) ? { layerTopsExact: true } : {}), ...(layerTopsMm && layerTopsMm === stored ? { layerTopsSliced: true } : {}), ...(heightRanges.length ? { heightRanges } : {}), ...(layerGcode.length ? { layerGcode } : {}), ...(toolChanges.length ? { toolChanges } : {}), ...(resume ? resumeSliceOptions(resume.plan, resume.declareZ) : {}) },
  }
  return { request, toPrint, config, replaces, skippedTools }
}

/**
 * The layers the shown plate prints, from the engine: the request slicePlate sends with no resume, sliced on this
 * device without G-code or a preview (never a cloud slice: it is read, not printed), and its layerZ. One source for
 * every layer plan (the plate's own layer heights, sleipnir, height ranges, objects' own heights, a Z shrinkage over
 * every filament the plate uses, painted ones included, and the printer's layer limits). A setting an opened project
 * brought that the engine refuses is dropped and the slice runs again, as slicePlate does; other refusals throw in the
 * words a slice shows. A host with no engine on this device turns it down (isNoLocalEngine), and that error reaches
 * the caller as it is. An abort stops it.
 */
export async function plateLayerZ(host: Host, signal: AbortSignal): Promise<number[]> {
  await (await import('./profile-sync')).profileReady()
  for (;;) {
    signal.throwIfAborted()
    const s: AppState = { ...sliceState(get()), resume: null }
    if (!s.plate.some((p) => p.printable !== false)) throw new Error('Nothing on this plate prints')
    const conflict = plateLayerHeightConflict(s, s.plates.find((p) => p.id === s.activePlate), resolveConfig(s.easy, s.overrides))
    if (conflict) throw new Error(conflict)
    const { request } = await plateSliceRequest(host, s, signal)
    let sliced
    try {
      // counted as every engine slice is, so auto slice starts none beside it, canceled or not (actions.ts engineSlice)
      sliced = await engineSlice(() => host.slicer.slice({ ...request, options: { ...request.options, emitGcode: false, emitPreview: false } }, { signal, local: true }), signal)
    } catch (e) {
      // A host that slices only in the cloud turns the local slice down: the caller asks for a slice instead.
      if (signal.aborted || isNoLocalEngine(e)) throw e
      const raw = e instanceof Error ? e.message : String(e)
      // Each round drops one key the file brought, so this ends.
      if (await dropRefusedProjectSetting(raw)) continue
      throw new Error(engineErrorText(raw))
    }
    try {
      signal.throwIfAborted()
      return Array.from(sliced.layerZ)
    } finally {
      host.slicer.release?.(sliced.id)
    }
  }
}

/**
 * slicePlate's options; `onStamp` gets the state the slice is stamped with, as it is stamped, and `onBegin` the slice's
 * own abort controller as it starts running (auto slice keeps it to know whether the running slice is its own).
 */
export interface SlicePlateOptions {
  auto?: boolean
  planning?: boolean
  plate?: string
  onStamp?: (at: AppState) => void
  onBegin?: (abort: AbortController) => void
}

/**
 * Slices the shown plate. `auto` is a background slice after an edit: nothing to say when there is nothing to slice,
 * and a failure shows in the panel, not as a toast. `planning` is the resume dialog's own slice to read the layers,
 * which goes while a void plan is kept. `plate` is the plate the caller asked for (mimir's slice, Export plate 3MF,
 * Export every plate): when another plate shows by the time the slice would start (a plate switch while the profile
 * loads or the project G-code question waits), nothing slices.
 */
export async function slicePlate(host: Host, opts: SlicePlateOptions = {}): Promise<void> {
  // a host with no engine (the CAD-only browser build) never starts a slice, from a shortcut, a command or auto slice
  if (!hostSlices()) return
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
  if (opts.plate !== undefined && at.activePlate !== opts.plate) return
  const s = at.historyEdit ? { ...at, plate: fullPlate(at) } : at
  if (s.plate.length === 0) {
    if (!opts.auto) toast('Add a model to the plate first')
    return
  }
  if (s.plate.every((p) => p.printable === false)) {
    if (!opts.auto) toast('Every object on this plate is set not to print. Turn one on first.')
    return
  }
  // A resume plan kept for this plate that no longer matches it: a slice of the whole plate would print into the part
  // still on the bed, so nothing slices until the plan is made again or cleared. Every slice comes through here (the
  // Slice button, auto slice, Export all plates, mimir and the print queue). `planning` is the resume dialog's own
  // slice, run to read the layers a new plan counts in: it slices the whole plate while the void plan stays kept, so
  // Print and Export still wait (printBlock) until a new plan is stored or the person chooses Print everything again.
  if (resumeVoid(at) && !opts.planning) {
    set({ slice: { status: 'error', message: RESUME_VOID, code: 'resume_void' }, preview: null })
    return
  }
  sliceStage(timed, 'ready')
  const base = resolveConfig(s.easy, s.overrides)
  const conflict = plateLayerHeightConflict(s, s.plates.find((p) => p.id === s.activePlate), base)
  if (conflict) {
    set({ slice: { status: 'error', message: conflict }, preview: null })
    return
  }
  // What this slice is for: the plate, the resume plan it uses and the plate's inputs. It lands only for the same plate
  // and plan, and Print and Export check it against the plate as it is then.
  const stamp = sliceStamp(at)
  // A caller that records the slice its own way (mimir's run) reads the plate at this same moment: after the profile
  // and the project G-code question, so a slice is never stale the moment it lands. A round after a refused project
  // setting reads it again.
  opts.onStamp?.(at)
  const abort = beginSlice()
  opts.onBegin?.(abort)
  // The last slice stays on screen, stale, until this one lands: the panels and the preview never empty in between.
  const before = shownSlice(get().slice)
  set({ slice: { status: 'running', progress: null, startedAt: performance.now(), ...(before ? { last: before.result, ...(before.stamp ? { lastStamp: before.stamp } : {}) } : {}) } })
  let again = false
  try {
    const { request, toPrint, config, replaces, skippedTools } = await plateSliceRequest(host, s, abort.signal, () => sliceStage(timed, 'objects'))
    const sliceWith = async () =>
      engineSlice(() => host.slicer.slice(request, {
        signal: abort.signal,
        onProgress: (progress) => {
          const cur = get().slice
          if (cur.status === 'running' && currentSlice(abort)) set({ slice: { ...cur, progress } })
        },
      }), abort.signal)
    // The native engine already spreads layers across threads; shards there only add halo work.
    sliceStage(timed, 'request')
    const sliced = await sliceWith()
    if (!currentSlice(abort)) return
    // A slice canceled as it finished is still canceled: its plate may be gone.
    if (abort.signal.aborted) throw new DOMException('Slice canceled', 'AbortError')
    // How long this plate took, for the next slice's size estimate (slice-estimate.ts).
    noteSliceTiming(s.activePlate, { triangles: plateTriangles(toPrint), ms: sliced.wallMs })
    sliceStage(timed, 'result', { ...(sliced.engineWallMs !== undefined ? { engineMs: sliced.engineWallMs } : {}), engineCpuMs: Object.values(sliced.stageMicros ?? {}).reduce((n: number, us) => n + (us ?? 0), 0) / 1000 })
    // The tower comes back in machine coordinates; the plate counts from its corner.
    const placed = sliced.primeTower ? { ...sliced, primeTower: towerToPlate(sliced.primeTower, areaOrigin(config['printable_area'])) } : sliced
    const notes = [...(replaces ? [replaces] : []), ...skippedTools].filter((n) => !placed.warnings.some((w) => w.message === n.message))
    const result = notes.length ? { ...placed, warnings: [...placed.warnings, ...notes] } : placed
    const raw = await host.slicer.getPreview(result.id)
    if (abort.signal.aborted) throw new DOMException('Slice canceled', 'AbortError')
    sliceStage(timed, 'preview', { previewBytes: raw.byteLength })
    const preview = readPreview(raw)
    sliceStage(timed, 'parsed')
    // Another plate shown, or this plate's resume plan kept, cleared, replaced or voided while it ran: what it made is
    // not this plate's G-code. A plate switch already put the shown plate's own slice on screen.
    const now = get()
    if (now.activePlate !== stamp.plate || planFor(now, stamp.plate) !== stamp.plan) {
      host.slicer.release?.(result.id)
      if (now.activePlate === stamp.plate) set(resumeVoid(now) ? { slice: { status: 'error', message: RESUME_VOID, code: 'resume_void' }, preview: null } : { slice: { status: 'idle' }, preview: null })
      return
    }
    const cur = get()
    set((st) => ({ slicesDone: st.slicesDone + 1 }))
    // An edit made while it ran leaves it stale: it shows, and the next slice replaces it before anything prints. That is
    // anything in the plate's inputs key or in what else goes into its G-code (outputKey: a pause or color change, an
    // object's name, whether the profile's G-code is trusted as shipped), not what changes on its own, such as grams left
    // on a spool.
    const edited = sliceInputsKey(cur) !== stamp.inputs || outputKey(cur) !== stamp.output
    set({ slice: { status: 'done', result, stale: edited, stamp }, sliceHeld: false, preview, strikePick: null, strikeJump: null, strikeHover: null, pickRing: null, ...layersAfterSlice(cur, preview.layerCount, cur.norn.before !== null), ...colorModeAfterSlice(cur, defaultColorMode(preview)) })
    sliceStage(timed, 'shown')
    markOpenStage('sliced')
  } catch (e) {
    if (abort.signal.aborted) {
      // A newer slice may already be running; its state is not ours to reset.
      if (currentSlice(abort)) {
        const cur = get().slice
        // The last slice comes back stale with its own stamp, so it is judged for what it was made for.
        set({ slice: cur.status === 'running' && cur.last ? { status: 'done', result: cur.last, stale: true, ...(cur.lastStamp ? { stamp: cur.lastStamp } : {}) } : { status: 'idle' } })
      }
      return
    }
    const raw = e instanceof Error ? e.message : String(e)
    const message = engineErrorText(raw)
    if (await dropRefusedProjectSetting(raw)) again = true
    else {
      // A refused slice (off the bed, in an excluded area) must not leave the last slice's toolpaths looking current.
      set({ slice: { status: 'error', message }, preview: null })
      if (!opts.auto) toast(message, 'error')
    }
  } finally {
    endSlice(abort)
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
    objectSettings: Object.fromEntries(Object.entries(s.objectSettings).flatMap(([id, own]) => {
      const { [key]: _gone, ...rest } = own
      return Object.keys(rest).length ? [[id, rest]] : []
    })),
    projectSettings: { ...brought, keys: brought.keys.filter((k) => k !== key) },
  }))
  const { settingDef } = await import('@slicerx/settings')
  toast(`Setting not imported from ${brought.source}: ${settingDef(key)?.label ?? key} (${reason}). Using your profile's value.`, 'warn')
  return true
}
