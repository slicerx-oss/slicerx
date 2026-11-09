// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Saving and export. Projects and models are saved only as .sx3mf: the Bambu Studio and OrcaSlicer
// 3MF layout with SlicerX metadata (model id, creator id, exporting user id). G-code and
// .gcode.3mf stay as print output, since printers need them.
import type { Host, SettingValue } from '@slicerx/contracts'
import { loadSettings, type SettingsApi } from '../adapters/load'
import { exportPlateGcode } from '../calibration/gcode'
import { slotConfig } from '../filament/slot-config'
import { currentHotends, currentMap, mapExtruders, mapHotends, masterExtruder, pickedMap } from '../filament/nozzle-map'
import { usedSlots } from '../filament/slots'
import { activeMeta, allPlates, projectBase, switchPlate } from '../plate/plates'
import { printBlock } from '../plate/heimdall'
import { heldBodies } from '../plate/timeline'
import { projectPlans } from '../project/plans-source'
import { markClean } from '../project/unsaved'
import { slicePlate, STALE_SLICE } from '../state/actions'
import { get, set, toast, type PlateEntry, type PlateMeta } from '../state/store'
import { exportAllBlock, needsSlice, stampBlock } from '../plate/resume-tops'
import { appName } from '../edition'
import { exportingUserId } from './identity'
import { savedPaintNote } from './paint-check'
import { railFilaments, type RailFilaments } from './rail-filaments'
import type { ProjectInput } from './threemf'
import { fromVault } from './vault'
import { evenFilamentLists } from '@slicerx/settings/slot-settings'

const fileBase = projectBase

/**
 * The settings a file carries, as project files write them. With `rail` (a project save) they list every filament on the rail,
 * each per-filament list with one entry per filament; without it, the filaments the slice prints (print output).
 */
function orcaSettings(api: SettingsApi, extra: Record<string, unknown> = {}, rail: RailFilaments | null = null): Record<string, unknown> {
  const s = get()
  const config = api.resolveConfig(s.easy, s.overrides) as Record<string, SettingValue>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    const def = api.settingDef(k)
    out[k] = def ? api.toOrca(def, v) : v
  }
  // Multi-color plates carry their filament colors, types and flush matrix, as strings like Orca's project files.
  for (const [k, v] of Object.entries(rail?.slotKeys ?? slotConfig(s))) out[k] = Array.isArray(v) ? v.map(String) : String(v)
  // Each slot's preset id, which Bambu printers read per tray (tray_info_idx); empty for a slot without a preset, as Orca writes it.
  const ids = s.profile?.filamentIds
  if (ids?.length) out['filament_ids'] = [...ids]
  // Every filament of the save in every per-filament list, those no part prints with their own values.
  if (rail) Object.assign(out, evenFilamentLists(out, rail.count, rail.own))
  // A printer with two extruders: the plate's filament map as Bambu Studio keeps it in the project (`filament_map`
  // per filament, 1 the left extruder, and `filament_map_mode`), the slicer's pick unless the plate set its own.
  if (mapExtruders(config) === 2) {
    const meta = activeMeta(s)
    const colours = out['filament_colour']
    const slots = Array.isArray(colours) ? colours.length : 1
    out['filament_map'] = currentMap(meta, pickedMap(s), slots, masterExtruder(config)).map(String)
    out['filament_map_mode'] = meta?.settings.nozzleMap ? 'Manual' : 'Auto For Flush'
  }
  // A printer whose hotends are its tools (the H3C): every filament on its one extruder, and the tool of each
  // (`filament_nozzle_map`, hotends from 0), the slicer's pick unless the plate set its own.
  if (mapHotends(config) > 0) {
    const meta = activeMeta(s)
    const colours = out['filament_colour']
    const slots = Array.isArray(colours) ? colours.length : 1
    out['filament_map'] = Array.from({ length: slots }, () => '1')
    out['filament_nozzle_map'] = currentHotends(meta, pickedMap(s), config, slots, [...usedSlots(s)]).map((t) => String(t - 1))
    out['filament_map_mode'] = meta?.settings.hotendMap ? 'Manual' : 'Auto For Flush'
  }
  // Values other slicers refuse from a project (an automatic filament ironing speed, an empty post-processing list) are
  // left out, so the file opens in them without a settings error and reopens here the same.
  return api.withoutRefusedValues({ ...out, ...extra })
}

/** The settings of a .gcode.3mf, which a Bambu Lab printer, Bambu Studio and OrcaSlicer read: in their values. */
function printSettings(api: SettingsApi): Record<string, unknown> {
  return api.orcaReadable(orcaSettings(api))
}

async function saveBytes(host: Host, name: string, bytes: Uint8Array, type: string, accept: string): Promise<boolean> {
  const ref = await host.files.save(name, new Blob([bytes as BlobPart], { type }), { accept: [accept] })
  if (ref) toast(`Saved ${ref.name}`, 'ok')
  return ref !== null
}

/** The model and creator ids shared by every object, for the model-level sx: entries. */
function sharedSource(plates: readonly PlateMeta[]): { modelId?: string; creatorId?: string } {
  const objs = plates.flatMap((p) => p.objects)
  const one = <K extends 'modelId' | 'creatorId'>(k: K) => {
    const vals = new Set(objs.map((o) => o.source?.[k] ?? ''))
    const v = vals.size === 1 ? [...vals][0] : ''
    return v ? { [k]: v } : {}
  }
  return { ...one('modelId'), ...one('creatorId') }
}

/**
 * Print output made from Vault designs leaves without the model: the file holds the G-code, its MD5, the plate
 * pictures, slice_info.config and plate_N.json (the objects a printer can skip), and a model part with no mesh
 * (`meshless`, packages/threemf/src/project.ts). Its root model carries the sx:Listing and sx:Creator of the first
 * Vault design on the plates, so the file still reads as a Vault design. Checked on the A1 and A1 mini: they print
 * it, list its objects to skip, reprint it from their file list and start it from the SD card. Other print output
 * stays plain 3MF with the model.
 */
async function printMarks(plates: readonly PlateMeta[]): Promise<Pick<ProjectInput, 'sx' | 'meshless'>> {
  const objects = plates.flatMap((p) => p.objects)
  if (!fromVault(objects)) return {}
  const first = objects.find((o) => o.source?.modelId)?.source ?? {}
  const source = { ...(first.modelId ? { modelId: first.modelId } : {}), ...(first.creatorId ? { creatorId: first.creatorId } : {}) }
  return { sx: { ...source, exportedBy: await exportingUserId() }, meshless: true }
}

/**
 * Builds the .sx3mf bytes for plates. `offPage` writes them in the project worker, so a big project no longer holds
 * the page for seconds; without a worker, or when it fails, the page writes them. `withoutHistory` writes the plates as
 * they show with no design history (a Vault upload): the upload check refuses the history's binary meshes and the
 * library does not keep the history, so the bodies held past a rolled back marker are left out with it.
 */
export async function sx3mfBytes(plates: readonly PlateMeta[], extra: Partial<Pick<ProjectInput, 'settings' | 'gcode'>> = {}, opts: { offPage?: boolean; withoutHistory?: boolean } = {}): Promise<Uint8Array> {
  const s = get()
  const api = extra.settings ? null : await loadSettings()
  const settings = extra.settings ?? orcaSettings(api!, {}, await railFilaments(api!))
  // a project saved rolled back keeps the bodies made after the marker
  const held = extra.gcode || opts.withoutHistory ? [] : heldBodies(s)
  const written = held.length ? plates.map((p) => ({ ...p, objects: [...p.objects, ...held.filter((h) => h.plate === p.id).map((h) => h.entry)] })) : plates
  // the mimir plans its designs were built from, when a plan is open; none adds no part, and an upload carries none
  const plans = extra.gcode || opts.withoutHistory ? undefined : projectPlans(written.flatMap((p) => p.objects))
  const input: ProjectInput = {
    plates: written,
    bed: s.bed,
    settings,
    objectSettings: s.objectSettings,
    layerMarks: Object.fromEntries(plates.flatMap((p, i) => ((s.layerMarks[p.id] ?? []).length ? [[i, s.layerMarks[p.id]!.map(({ z, kind, gcode, slot, skip }) => ({ z, kind, ...(gcode ? { gcode } : {}), ...(slot ? { slot } : {}), ...(skip ? { skipped: true } : {}) }))]] : []))),
    sx: { ...sharedSource(plates), exportedBy: await exportingUserId() },
    namedValues: s.namedValues,
    timeline: s.timeline,
    ...(opts.withoutHistory ? { history: false } : {}),
    ...(plans ? { plans } : {}),
    // Named here: the worker does not know the edition the page runs as.
    application: appName(),
  }
  if (opts.offPage && typeof Worker !== 'undefined') {
    try {
      return await (await import('./project-worker-client')).writeProjectInWorker(input)
    } catch {
      // Written on the page below.
    }
  }
  return (await import('./threemf')).writeProjectCompressed(input)
}

/** Save the project: every plate, as .sx3mf. */
/**
 * Saves the project. Once it has a file (opened or saved before) Save writes there without asking; Save as
 * (`as: true`) always asks, and the new file becomes the project's file.
 */
export async function saveProject(host: Host, opts: { as?: boolean } = {}): Promise<boolean> {
  const plates = allPlates(get())
  if (plates.every((p) => p.objects.length === 0)) {
    toast('There is nothing on the plates to save.', 'info')
    return false
  }
  const bytes = await sx3mfBytes(plates)
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.slicerx.sx3mf' })
  const file = get().projectFile
  const ref = !opts.as && file && host.files.saveTo ? await host.files.saveTo(file, blob) : await host.files.save(`${fileBase()}.sx3mf`, blob, { accept: ['.sx3mf'] })
  if (!ref) return false
  // Paint above filament 16 saves for every reader that takes it; one slicer can't show it, and the toast says so on its
  // second line, where Details would hide it.
  const paintNote = savedPaintNote(plates.flatMap((p) => p.objects))
  if (paintNote) toast(`Saved ${ref.name}. ${paintNote}`, 'warn', undefined, undefined, { secondLine: true })
  else toast(`Saved ${ref.name}`, 'ok')
  if (ref.path) set({ projectFile: ref })
  markClean()
  void import('../project/autosave').then((m) => m.projectSaved(ref.name, bytes))
  return true
}

const NOT_SLICED = 'It did not slice.'

/**
 * The shown plate's G-code, or why there is none: no slice, a stale one, or one made for another plate or resume plan
 * (stampBlock). Collisions and the other print checks are the caller's.
 */
async function gcodeText(host: Host): Promise<{ text: string } | { reason: string }> {
  const s = get()
  const slice = s.slice
  if (slice.status === 'error') return { reason: slice.message }
  if (slice.status !== 'done') return { reason: NOT_SLICED }
  if (slice.stale) return { reason: STALE_SLICE }
  const stamped = stampBlock(s, slice.stamp)
  if (stamped) return { reason: stamped }
  const out = await exportPlateGcode(host, slice.result.id)
  return out.blob ? { text: await out.blob.text() } : { reason: 'The slicer returned no G-code.' }
}

/** Export's answer when another plate showed while the plate it was exporting sliced. */
export const EXPORT_SWITCHED = 'Another plate was shown before this one finished slicing, so nothing was exported. Show the plate and export it again.'

/** Export every plate's answer when another plate showed while one of them sliced. */
export const exportAllSwitched = (plate: string): string => `${plate}: another plate was shown while it sliced, so nothing was saved. Run Export every plate again.`

/** Print output: the sliced active plate as .gcode.3mf, the file Bambu Lab printers take. Slices first when needed. */
export async function exportGcode3mf(host: Host): Promise<boolean> {
  const s = get()
  if (needsSlice(s)) await slicePlate(host, { plate: s.activePlate })
  // The slice waits on the profile and may ask a question first: the file is the plate it was asked for, or nothing.
  if (get().activePlate !== s.activePlate) {
    toast(EXPORT_SWITCHED, 'error')
    return false
  }
  const unsafe = printBlock(get())
  if (unsafe) {
    toast(unsafe, 'error')
    return false
  }
  // A reslice that was canceled or waits on a question leaves the last slice, stale: it is not the plate's file.
  const got = await gcodeText(host)
  if ('reason' in got) {
    const unsliced = got.reason === STALE_SLICE || got.reason === NOT_SLICED
    toast(unsliced ? 'Slice the plate first.' : got.reason, unsliced ? 'info' : 'error')
    return false
  }
  const text = got.text
  const index = Math.max(0, s.plates.findIndex((p) => p.id === s.activePlate))
  const plates = allPlates(get())
  const bytes = await (await import('./threemf')).writeProjectCompressed({ plates, bed: s.bed, settings: printSettings(await loadSettings()), gcode: { [index]: text }, ...(await printMarks(plates)) })
  return saveBytes(host, `${fileBase()}.gcode.3mf`, bytes, 'model/3mf', '.gcode.3mf')
}

/**
 * The file the Print sheet sends to a Bambu Lab printer: the active plate alone as plate 1 of a .gcode.3mf, with
 * its G-code, the MD5 the printer checks, slice_info.config (objects the printer can skip, filaments, the
 * printer's facts), plate_1.json and the thumbnails. The printer starts it with `project_file` and `param`
 * Metadata/plate_1.gcode, so the person's slot choice reaches it as `ams_mapping`. `plateNumber` (1 based) picks
 * another plate than the active one, for printer.queue, which sends the plate it sliced.
 */
export async function printGcode3mf(gcode: string, plateNumber?: number): Promise<Uint8Array> {
  const s = get()
  const all = allPlates(s)
  const plate = (plateNumber !== undefined ? all[plateNumber - 1] : undefined) ?? all.find((p) => p.id === s.activePlate)
  const plates = plate ? [plate] : []
  return (await import('./threemf')).writeProjectCompressed({ plates, bed: s.bed, settings: printSettings(await loadSettings()), gcode: { 0: gcode }, ...(await printMarks(plates)) })
}

/** Print output: slices every plate that has objects and writes them all into one .gcode.3mf. */
export async function exportAllPlates(host: Host): Promise<boolean> {
  const blocked = exportAllBlock(get())
  if (blocked) {
    toast(blocked, 'error')
    return false
  }
  const start = get().activePlate
  const gcode: Record<number, string> = {}
  const plates = get().plates
  // A plate the person showed while a plate sliced stays shown.
  let theirs = false
  try {
    for (const [i, p] of plates.entries()) {
      switchPlate(p.id)
      if (get().plate.length === 0) continue
      await slicePlate(host, { plate: p.id })
      if (get().activePlate !== p.id) {
        theirs = true
        toast(exportAllSwitched(p.name), 'error')
        return false
      }
      const got = await gcodeText(host)
      if ('reason' in got) {
        toast(`${p.name}: ${got.reason}`, 'error')
        return false
      }
      gcode[i] = got.text
    }
  } finally {
    if (!theirs) switchPlate(start)
  }
  if (Object.keys(gcode).length === 0) {
    toast('There is nothing on the plates to slice.', 'info')
    return false
  }
  const s = get()
  const all = allPlates(s)
  return saveBytes(host, `${fileBase()}.gcode.3mf`, await (await import('./threemf')).writeProjectCompressed({ plates: all, bed: s.bed, settings: printSettings(await loadSettings()), gcode, ...(await printMarks(all)) }), 'model/3mf', '.gcode.3mf')
}

/**
 * mimir's ProjectExportHost (packages/pilot/src/hosts.ts): saves the plate holding the object
 * as .sx3mf, with the filament colors and materials the model asked for.
 */
export function projectExportHost(host: Host) {
  return {
    async export3mf(req: { objectId: string; plate?: number; name?: string; slots: { slot: number; color: string; material: string; preset?: string }[] }): Promise<{ fileName: string; bytes: number } | null> {
      const plates = allPlates(get())
      const plate = plates.find((p) => p.objects.some((o) => o.id === req.objectId)) ?? plates[req.plate ?? 0]
      if (!plate) return null
      const slots = [...req.slots].sort((a, b) => a.slot - b.slot)
      // The model's filaments in their slots, over the rail's, with every per-filament list as long as the filaments.
      const api = await loadSettings()
      const top = slots.reduce((n, x) => Math.max(n, x.slot), 0)
      const base = orcaSettings(api, {}, await railFilaments(api, top))
      const count = Math.max(top, Array.isArray(base['filament_colour']) ? base['filament_colour'].length : 1)
      const bySlot = (key: string, value: (x: (typeof slots)[number]) => string): unknown[] => {
        const list: unknown[] = Array.isArray(base[key]) ? [...(base[key] as unknown[])] : []
        for (const x of slots) list[x.slot - 1] = value(x)
        return list
      }
      const settings = evenFilamentLists(
        {
          ...base,
          filament_colour: bySlot('filament_colour', (x) => x.color),
          filament_type: bySlot('filament_type', (x) => x.material),
          ...(slots.some((x) => x.preset) ? { filament_settings_id: bySlot('filament_settings_id', (x) => x.preset ?? '') } : {}),
        },
        count,
      )
      const bytes = await sx3mfBytes([plate], { settings })
      const name = `${(req.name ?? fileBase(plate.objects)).replace(/\.(sx)?3mf$/i, '')}.sx3mf`
      const ref = await host.files.save(name, new Blob([bytes as BlobPart], { type: 'application/vnd.slicerx.sx3mf' }), { accept: ['.sx3mf'] })
      return ref ? { fileName: ref.name, bytes: bytes.length } : null
    },
  }
}
