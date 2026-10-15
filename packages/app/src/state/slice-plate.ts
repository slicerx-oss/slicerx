// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slicing a plate: the configuration and objects the engine gets, and the run itself. It loads the first time a plate
// slices (actions.ts slicePlate), so the startup shell stays small.
import { engineErrorText } from '../lib/engine-errors'
import type { Host, LayerGcode, PlateObject, PrintConfig, SlicerHost } from '@slicerx/contracts'
import { readPreview } from '@slicerx/contracts'
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
import { plateSequence } from '../plate/plate-sequence'
import { layerHeightConflict, objectOverrides, partOverridesOf, settingsObjects } from '../plate/object-settings'
import { markOpenStage } from '../lib/open-mark'
import { sliceStage, sliceStarted } from '../lib/slice-timing'
import { colorModeAfterSlice, fullPlate, get, openRightOnSlice, set, shownSlice, toast, type AppState, type PlateEntry, type PlateMeta } from './store'
import { beginSlice, currentSlice, endSlice, layersAfterSlice, trustOptions } from './actions'
import { hostSlices } from './model-mode'

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
  const shared = settingsObjects(s)
  return toPrint.map((p, i) => objectToMachine({ id: p.id, name: p.name, mesh: handles[i]!.id, transform: p.transform, ...overridesOf(meta, p), ...(p.volumes?.length ? { volumes: requestVolumes(p) } : {}), ...(Object.keys(objectOverrides(s, p)).length ? { settings: objectOverrides(s, p) } : {}), ...(Object.keys(partOverridesOf(shared, p)).length ? { partSettings: partOverridesOf(shared, p) } : {}), ...(p.brimPoints?.length ? { brimPoints: p.brimPoints } : {}) }, origin))
}

/** `auto` is a background slice after an edit: nothing to say when there is nothing to slice, and a failure shows in the panel, not as a toast. */
export async function slicePlate(host: Host, opts: { auto?: boolean } = {}): Promise<void> {
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
  const abort = beginSlice()
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
            if (cur.status === 'running' && currentSlice(abort)) set({ slice: { ...cur, progress } })
          },
        },
      )
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
    const result = sliced.primeTower ? { ...sliced, primeTower: towerToPlate(sliced.primeTower, areaOrigin(config['printable_area'])) } : sliced
    const raw = await host.slicer.getPreview(result.id)
    if (abort.signal.aborted) throw new DOMException('Slice canceled', 'AbortError')
    sliceStage(timed, 'preview', { previewBytes: raw.byteLength })
    const preview = readPreview(raw)
    sliceStage(timed, 'parsed')
    const cur = get()
    set((st) => ({ slicesDone: st.slicesDone + 1 }))
    set({ slice: { status: 'done', result, stale: false }, sliceHeld: false, preview, strikePick: null, strikeJump: null, strikeHover: null, ...layersAfterSlice(cur, preview.layerCount, cur.norn.before !== null), ...colorModeAfterSlice(cur, defaultColorMode(preview)) })
    // The summary of what just sliced: the right pane opens unless the person shut it for this project.
    openRightOnSlice()
    sliceStage(timed, 'shown')
    markOpenStage('sliced')
  } catch (e) {
    if (abort.signal.aborted) {
      // A newer slice may already be running; its state is not ours to reset.
      if (currentSlice(abort)) {
        const cur = get().slice
        set({ slice: cur.status === 'running' && cur.last ? { status: 'done', result: cur.last, stale: true } : { status: 'idle' } })
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
    projectSettings: { ...brought, keys: brought.keys.filter((k) => k !== key) },
  }))
  const { settingDef } = await import('@slicerx/settings')
  toast(`Setting not imported from ${brought.source}: ${settingDef(key)?.label ?? key} (${reason}). Using your profile's value.`, 'warn')
  return true
}
