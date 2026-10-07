// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Saving and export. Projects and models are saved only as .sx3mf: the Bambu Studio and OrcaSlicer
// 3MF layout with SlicerX metadata (model id, creator id, exporting user id). G-code and
// .gcode.3mf stay as print output, since printers need them.
import type { Host, SettingValue } from '@slicerx/contracts'
import { loadSettings, type SettingsApi } from '../adapters/load'
import { exportPlateGcode } from '../calibration/gcode'
import { slotConfig } from '../filament/slots'
import { currentMap, mapExtruders, masterExtruder, pickedMap } from '../filament/nozzle-map'
import { activeMeta, allPlates, projectBase, switchPlate } from '../plate/plates'
import { printBlock } from '../plate/heimdall'
import { markClean } from '../project/unsaved'
import { slicePlate } from '../state/actions'
import { get, set, toast, type PlateEntry, type PlateMeta } from '../state/store'
import { exportingUserId } from './identity'
import type { ProjectInput } from './threemf'
import { fromVault } from './vault'

const fileBase = projectBase

function orcaSettings(api: SettingsApi, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const s = get()
  const config = api.resolveConfig(s.easy, s.overrides) as Record<string, SettingValue>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    const def = api.settingDef(k)
    out[k] = def ? api.toOrca(def, v) : v
  }
  // Multi-color plates carry their filament colors, types and flush matrix, as strings like Orca's project files.
  for (const [k, v] of Object.entries(slotConfig(s))) out[k] = Array.isArray(v) ? v.map(String) : String(v)
  // Each slot's preset id, which Bambu printers read per tray (tray_info_idx); empty for a slot without a preset, as Orca writes it.
  const ids = s.profile?.filamentIds
  if (ids?.length) out['filament_ids'] = [...ids]
  // A printer with two extruders: the plate's filament map as Bambu Studio keeps it in the project (`filament_map`
  // per filament, 1 the left extruder, and `filament_map_mode`), the slicer's pick unless the plate set its own.
  if (mapExtruders(config) === 2) {
    const meta = activeMeta(s)
    const colours = out['filament_colour']
    const slots = Array.isArray(colours) ? colours.length : 1
    out['filament_map'] = currentMap(meta, pickedMap(s), slots, masterExtruder(config)).map(String)
    out['filament_map_mode'] = meta?.settings.nozzleMap ? 'Manual' : 'Auto For Flush'
  }
  return { ...out, ...extra }
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
 * Print output made from Vault designs carries their sx:Listing and sx:Creator too, on the root model and on each
 * object, so the file opens again as a Vault design. Other print output stays plain 3MF.
 */
async function printMarks(plates: readonly PlateMeta[]): Promise<Pick<ProjectInput, 'sx'>> {
  return fromVault(plates.flatMap((p) => p.objects)) ? { sx: { ...sharedSource(plates), exportedBy: await exportingUserId() } } : {}
}

/** Builds the .sx3mf bytes for plates. */
export async function sx3mfBytes(plates: readonly PlateMeta[], extra: Partial<Pick<ProjectInput, 'settings' | 'gcode'>> = {}): Promise<Uint8Array> {
  const s = get()
  const settings = extra.settings ?? orcaSettings(await loadSettings())
  return (await import('./threemf')).writeProjectCompressed({
    plates,
    bed: s.bed,
    settings,
    objectSettings: s.objectSettings,
    layerMarks: Object.fromEntries(plates.flatMap((p, i) => ((s.layerMarks[p.id] ?? []).length ? [[i, s.layerMarks[p.id]!.map(({ z, kind, gcode }) => ({ z, kind, ...(gcode ? { gcode } : {}) }))]] : []))),
    sx: { ...sharedSource(plates), exportedBy: await exportingUserId() },
    namedValues: s.namedValues,
  })
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
  toast(`Saved ${ref.name}`, 'ok')
  if (ref.path) set({ projectFile: ref })
  markClean()
  void import('../project/autosave').then((m) => m.projectSaved(ref.name, bytes))
  return true
}

async function gcodeText(host: Host): Promise<string | null> {
  const slice = get().slice
  if (slice.status !== 'done') return null
  const out = await exportPlateGcode(host, slice.result.id)
  return out.blob ? await out.blob.text() : null
}

/** Print output: the sliced active plate as .gcode.3mf, the file Bambu Lab printers take. Slices first when needed. */
export async function exportGcode3mf(host: Host): Promise<boolean> {
  const s = get()
  const resliced = s.slice.status !== 'done' || s.slice.stale
  if (resliced) await slicePlate(host)
  const unsafe = printBlock(get())
  if (unsafe) {
    toast(unsafe, 'error')
    return false
  }
  const text = await gcodeText(host)
  if (text === null) {
    toast('Slice the plate first.', 'info')
    return false
  }
  const index = Math.max(0, s.plates.findIndex((p) => p.id === s.activePlate))
  const plates = allPlates(get())
  const bytes = await (await import('./threemf')).writeProjectCompressed({ plates, bed: s.bed, settings: orcaSettings(await loadSettings()), gcode: { [index]: text }, ...(await printMarks(plates)) })
  return saveBytes(host, `${fileBase()}.gcode.3mf`, bytes, 'model/3mf', '.gcode.3mf')
}

/**
 * The file the Print sheet sends to a Bambu Lab printer: the active plate alone as plate 1 of a .gcode.3mf, with
 * its G-code, the MD5 the printer checks, slice_info.config (objects the printer can skip, filaments, the
 * printer's facts), plate_1.json and the thumbnails. The printer starts it with `project_file` and `param`
 * Metadata/plate_1.gcode, so the person's slot choice reaches it as `ams_mapping`.
 */
export async function printGcode3mf(gcode: string): Promise<Uint8Array> {
  const s = get()
  const active = allPlates(s).find((p) => p.id === s.activePlate)
  const plates = active ? [active] : []
  return (await import('./threemf')).writeProjectCompressed({ plates, bed: s.bed, settings: orcaSettings(await loadSettings()), gcode: { 0: gcode }, ...(await printMarks(plates)) })
}

/** Print output: slices every plate that has objects and writes them all into one .gcode.3mf. */
export async function exportAllPlates(host: Host): Promise<boolean> {
  const start = get().activePlate
  const gcode: Record<number, string> = {}
  const plates = get().plates
  try {
    for (const [i, p] of plates.entries()) {
      switchPlate(p.id)
      if (get().plate.length === 0) continue
      await slicePlate(host)
      const text = await gcodeText(host)
      if (text === null) {
        const cur = get().slice
        toast(`${p.name} did not slice${cur.status === 'error' ? `: ${cur.message}` : ''}`, 'error')
        return false
      }
      gcode[i] = text
    }
  } finally {
    switchPlate(start)
  }
  if (Object.keys(gcode).length === 0) {
    toast('There is nothing on the plates to slice.', 'info')
    return false
  }
  const s = get()
  const all = allPlates(s)
  return saveBytes(host, `${fileBase()}.gcode.3mf`, await (await import('./threemf')).writeProjectCompressed({ plates: all, bed: s.bed, settings: orcaSettings(await loadSettings()), gcode, ...(await printMarks(all)) }), 'model/3mf', '.gcode.3mf')
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
      const settings = orcaSettings(await loadSettings(), {
        filament_colour: slots.map((x) => x.color),
        filament_type: slots.map((x) => x.material),
        ...(slots.some((x) => x.preset) ? { filament_settings_id: slots.map((x) => x.preset ?? '') } : {}),
      })
      const bytes = await sx3mfBytes([plate], { settings })
      const name = `${(req.name ?? fileBase(plate.objects)).replace(/\.(sx)?3mf$/i, '')}.sx3mf`
      const ref = await host.files.save(name, new Blob([bytes as BlobPart], { type: 'application/vnd.slicerx.sx3mf' }), { accept: ['.sx3mf'] })
      return ref ? { fileName: ref.name, bytes: bytes.length } : null
    },
  }
}
