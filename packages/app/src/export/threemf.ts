// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes 3MF projects the way Bambu Studio and OrcaSlicer read them: the 3MF core model with one
// object per plate object (parts as components), Metadata/model_settings.config for plates, part
// names and filament slots, and Metadata/project_settings.config with the print settings. A sliced
// plate goes in as Metadata/plate_N.gcode with its MD5, which makes a .gcode.3mf. With `sx` it is an
// .sx3mf: the same layout with SlicerX metadata.
import type { NamedValue } from '../cad/value-names'
import { valuesJson } from './values-file'
import type { MeshPart } from '@slicerx/contracts'
import { bake } from '../plate/mesh-ops'
import { areaOrigin } from '../plate/bed-origin'
import type { Dimension, DimensionAnchor } from '../geom/cad'
import { plateObjectsFromGcode } from '../features/fleet/device'
import { historyFiles } from './history-file'
import type { PlateEntry, PlateMeta, VolumeRole } from '../state/store'
import { md5Hex } from './md5'
import { plateSequence } from '../plate/plate-sequence'
import { zip, zipCompressed, type ZipEntry } from './zip'
import { appName } from '../edition'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const f = (n: number) => {
  const r = Number(n.toFixed(4))
  return Object.is(r, -0) ? '0' : String(r)
}

/** 3MF transform attribute from a column-major 4x4: the first three rows of each column. */
export function transformAttr(m: readonly number[]): string {
  return [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((i) => f(m[i] ?? 0)).join(' ')
}

/** The triangle attributes Bambu Studio and OrcaSlicer use for painted surfaces (bbs_3mf.cpp). */
const PAINT_ATTR = { color: 'paint_color', seam: 'paint_seam', support: 'paint_supports', fuzzy: 'paint_fuzzy_skin' } as const
export type PaintOfPart = Partial<Record<keyof typeof PAINT_ATTR, Record<number, string>>>

function meshXml(p: MeshPart, paint?: PaintOfPart): string {
  const v: string[] = []
  for (let i = 0; i + 2 < p.positions.length; i += 3) v.push(`<vertex x="${f(p.positions[i]!)}" y="${f(p.positions[i + 1]!)}" z="${f(p.positions[i + 2]!)}"/>`)
  const t: string[] = []
  for (let i = 0; i + 2 < p.indices.length; i += 3) {
    const tri = i / 3
    let extra = ''
    if (paint) for (const [layer, attr] of Object.entries(PAINT_ATTR) as [keyof typeof PAINT_ATTR, string][]) {
      const text = paint[layer]?.[tri]
      if (text) extra += ` ${attr}="${esc(text)}"`
    }
    t.push(`<triangle v1="${p.indices[i]}" v2="${p.indices[i + 1]}" v3="${p.indices[i + 2]}"${extra}/>`)
  }
  return `<mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh>`
}

const VOLUME_SUBTYPE: Record<VolumeRole, string> = { negative: 'negative_part', support_blocker: 'support_blocker', support_enforcer: 'support_enforcer', modifier: 'modifier_part' }

/** A modifier's settings as the part's own metadata entries, in Orca's value format. */
function modifierMeta(settings: Record<string, unknown> | undefined): string {
  if (!settings) return ''
  // Orca writes booleans as 1 and 0 and lists joined by commas; the schema is not needed for that.
  const text = (v: unknown): string => (typeof v === 'boolean' ? (v ? '1' : '0') : Array.isArray(v) ? v.map(text).join(',') : String(v))
  return Object.entries(settings).map(([k, v]) => `<metadata key="${esc(k)}" value="${esc(text(v))}"/>`).join('')
}

const BED_TYPE_NAMES: Record<string, string> = {
  cool: 'Cool Plate',
  engineering: 'Engineering Plate',
  'high-temp': 'High Temp Plate',
  'textured-pei': 'Textured PEI Plate',
  'smooth-pei': 'High Temp Plate',
}

/** Orca's `bed_type_to_gcode_string` names, used in plate_N.json. */
const BED_TYPE_KEYS: Record<string, string> = {
  cool: 'cool_plate',
  engineering: 'eng_plate',
  'high-temp': 'hot_plate',
  'textured-pei': 'textured_plate',
  'smooth-pei': 'hot_plate',
}

/** Seconds of a time such as "1d 2h 3m 4s" after `prefix`, or undefined. */
function gcodeSeconds(text: string, prefix: string): number | undefined {
  const m = new RegExp(`^; ${prefix} = (?:(\\d+)d )?(?:(\\d+)h )?(?:(\\d+)m )?(\\d+)s`, 'm').exec(text)
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4]) : undefined
}
const footerSeconds = (text: string) => gcodeSeconds(text, 'estimated printing time \\(normal mode\\)')

/** A footer list such as "; filament used [g] = 3.00, 1.50", one number per filament. */
function footerList(text: string, key: string): number[] {
  const m = new RegExp(`^; ${key} = ([\\d., ]+)$`, 'm').exec(text)
  return m ? m[1]!.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : []
}

/** The label ids the engine lists in the "; model label id:" header line, from 1 in plate order. */
export function gcodeLabelIds(gcode: string): string[] {
  return (/^; model label id: ([\d,]+)/m.exec(gcode)?.[1] ?? '').split(',').filter(Boolean)
}

/** Bambu Lab model ids by printer model, from the `model_id` of each machine model in Orca 2.4.2's BBL profiles. */
export const BAMBU_MODEL_IDS: Readonly<Record<string, string>> = {
  'Bambu Lab A1': 'N2S',
  'Bambu Lab A1 mini': 'N1',
  'Bambu Lab H2D': 'O1D',
  'Bambu Lab H2D Pro': 'O1E',
  'Bambu Lab H2S': 'O1S',
  'Bambu Lab P1P': 'C11',
  'Bambu Lab P1S': 'C12',
  'Bambu Lab P2S': 'N7',
  'Bambu Lab X1': 'BL-P002',
  'Bambu Lab X1 Carbon': 'BL-P001',
  'Bambu Lab X1E': 'C13',
  'Bambu Lab X2D': 'N6',
}

/** A setting as a list of strings, whether it is stored as an array or as one value. */
function listSetting(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  if (v === undefined || v === null || v === '') return []
  return [String(v)]
}
const firstSetting = (v: unknown): string | undefined => listSetting(v)[0]
const truthy = (v: unknown): boolean => {
  const s = firstSetting(v)
  return s === 'true' || s === '1'
}

/** What slice_info.config and plate_N.json say about the printer and the filaments, read from the project settings. */
export interface SliceMachine {
  /** The printer's model id ("N2S" for the A1), empty for a printer that is not a Bambu Lab model Orca knows. */
  printerModelId: string
  nozzleDiameters: number[]
  /** Orca's ExtruderType numbers: 0 direct drive, 1 Bowden. */
  extruderTypes: number[]
  /** Orca's NozzleVolumeType numbers: 0 standard, 1 high flow. */
  nozzleVolumeTypes: number[]
  /** Orca's TimelapseType: 0 traditional, 1 smooth. */
  timelapseType: number
  supportUsed: boolean
  /** By filament index (0-based). */
  filaments: { type: string; color: string; trayInfoIdx: string }[]
  layerHeight: number
  /** The printable area's corners, for the outside check. */
  printableArea: [number, number][]
}

/** The printer and filament facts the printer-side metadata needs, from Orca-format project settings. */
export function sliceMachine(settings: Record<string, unknown>): SliceMachine {
  const nums = (v: unknown, fallback: number[]) => {
    const l = listSetting(v).map(Number).filter((n) => Number.isFinite(n))
    return l.length ? l : fallback
  }
  const nozzles = nums(settings['nozzle_diameter'], [0.4])
  const types = listSetting(settings['filament_type'])
  const colors = listSetting(settings['filament_colour'])
  const ids = listSetting(settings['filament_ids'])
  const count = Math.max(types.length, colors.length, 1)
  // Orca writes the area as ["0x0", "256x0", ...]; the resolved config holds [[0, 0], [256, 0], ...].
  const rawArea = settings['printable_area']
  const area = (Array.isArray(rawArea) ? (rawArea as unknown[]) : listSetting(rawArea).flatMap((s) => s.split(',')))
    .map((p) => (Array.isArray(p) ? p.map(Number) : String(p).split('x').map(Number)))
    .filter((p): p is [number, number] => p.length === 2 && p.every((n) => Number.isFinite(n)))
  // One entry per nozzle, as Orca's enum lists hold them; a printer that does not say is direct drive with a standard nozzle.
  const perNozzle = (v: unknown, one: RegExp) => {
    const l = listSetting(v)
    return l.length ? l.map((t) => (one.test(t) || t === '1' ? 1 : 0)) : nozzles.map(() => 0)
  }
  const tl = firstSetting(settings['timelapse_type'])
  return {
    printerModelId: BAMBU_MODEL_IDS[firstSetting(settings['printer_model']) ?? ''] ?? '',
    nozzleDiameters: nozzles,
    extruderTypes: perNozzle(settings['extruder_type'], /bowden/i),
    nozzleVolumeTypes: perNozzle(settings['nozzle_volume_type'], /high/i),
    timelapseType: tl === '1' || tl === 'smooth' ? 1 : 0,
    supportUsed: truthy(settings['enable_support']),
    filaments: Array.from({ length: count }, (_, i) => ({ type: types[i] ?? types[0] ?? 'PLA', color: colors[i] ?? colors[0] ?? '#FFFFFF', trayInfoIdx: ids[i] ?? '' })),
    layerHeight: Number(firstSetting(settings['layer_height']) ?? 0.2) || 0.2,
    printableArea: area,
  }
}

/** An object's footprint on the bed, for plate_N.json: its label id, name and the rectangle its extrusions cover. */
export interface PlateFootprint {
  id: string
  name: string
  box: [number, number, number, number]
}

/** True when any footprint leaves the printable area's bounding rectangle (Orca's `toolpath_outside`). */
function outsideOf(boxes: readonly PlateFootprint[], area: readonly [number, number][]): boolean {
  if (area.length < 3 || boxes.length === 0) return false
  const xs = area.map((p) => p[0])
  const ys = area.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  return boxes.some(({ box }) => box[0] < x0 - 1e-6 || box[1] < y0 - 1e-6 || box[2] > x1 + 1e-6 || box[3] > y1 + 1e-6)
}

const fixed2 = (n: number) => n.toFixed(2)
const plain = (n: number) => String(Number(n.toFixed(6)))

/**
 * The filament map of a plate on a printer with two extruders (Bambu Studio's `filament_maps`): the extruder of each
 * filament (1 the left, 2 the right), the nozzle of each (the `group_id` of slice_info, the left extruder's nozzle 0)
 * and the mode as Bambu Studio names it. From the sliced G-code's configuration block when there is one (the map the
 * engine printed with), else the plate's own map, else the slicer's pick to come. Null on a printer with one nozzle.
 */
export interface FilamentMapOut {
  mode: 'Auto For Flush' | 'Manual'
  maps: number[]
  nozzles: number[]
}

function configList(gcode: string, key: string): number[] | null {
  const m = new RegExp(`^; ${key} = ([\\d, ]+)$`, 'm').exec(gcode)
  return m ? m[1]!.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v)) : null
}

export function plateFilamentMap(machine: SliceMachine, plate?: Pick<PlateMeta, 'settings'>, gcode?: string): FilamentMapOut | null {
  if (machine.nozzleDiameters.length < 2) return null
  const n = machine.filaments.length
  const fromGcode = gcode !== undefined ? configList(gcode, 'filament_map') : null
  if (fromGcode?.length) {
    const nozzles = configList(gcode!, 'filament_nozzle_map') ?? fromGcode.map((e) => e - 1)
    const manual = /^; filament_map_mode = (Manual|Nozzle Manual)$/m.test(gcode!)
    return { mode: manual ? 'Manual' : 'Auto For Flush', maps: fromGcode, nozzles }
  }
  const own = plate?.settings.nozzleMap
  if (own?.length) {
    const maps = Array.from({ length: Math.max(n, own.length) }, (_, i) => own[i] ?? own[own.length - 1] ?? 1)
    return { mode: 'Manual', maps, nozzles: maps.map((e) => e - 1) }
  }
  const maps = Array.from({ length: n }, () => 1)
  return { mode: 'Auto For Flush', maps, nozzles: maps.map(() => 0) }
}

/** The filaments a G-code file uses: index (0-based), meters and grams from its footer. */
function usedFilaments(gcode: string): { id: number; m: number; g: number }[] {
  const mm = footerList(gcode, 'filament used \\[mm\\]')
  const g = footerList(gcode, 'filament used \\[g\\]')
  const out: { id: number; m: number; g: number }[] = []
  for (let i = 0; i < Math.max(mm.length, g.length); i++) if ((mm[i] ?? 0) > 0 || (g[i] ?? 0) > 0) out.push({ id: i, m: (mm[i] ?? 0) / 1000, g: g[i] ?? 0 })
  return out
}

/**
 * Metadata/slice_info.config for the sliced plates, in the layout of Bambu Studio and Orca 2.4.2
 * (`_add_slice_info_config_file_to_archive` in bbs_3mf.cpp): a header, then per plate its index, the
 * printer's facts (extruder and nozzle volume type, model id, nozzle diameters, timelapse type), the
 * estimate (seconds) and weight (g) from the G-code footer, the first layer time from its header, whether
 * the toolpaths leave the bed, whether supports print, one `<object identify_id name skipped/>` per object,
 * one `<filament>` per filament the plate uses and the nozzle. The printer's own skip dialog lists those
 * objects, so identify_id is the id the G-code labels the object with: the engine lists them from 1 in the
 * "; model label id:" header line, in plate order, and a file without that line (no Bambu labels) lists none.
 * `names` are the plate's printing objects in that order.
 */
export function sliceInfoXml(plates: { index: number; gcode: string; names: readonly string[]; outside?: boolean; plate?: Pick<PlateMeta, 'settings'> | undefined }[], machine: SliceMachine = sliceMachine({})): string {
  const meta = (key: string, value: string | number | boolean) => `    <metadata key="${key}" value="${esc(String(value))}"/>\n`
  const body = plates.map(({ index, gcode, names, outside, plate }) => {
    const ids = gcodeLabelIds(gcode)
    const seconds = footerSeconds(gcode)
    const grams = /^; total filament used \[g\] = ([\d.]+)/m.exec(gcode)?.[1]
    const firstLayer = gcodeSeconds(gcode, 'estimated first layer printing time \\(normal mode\\)') ?? 0
    const used = usedFilaments(gcode)
    const map = plateFilamentMap(machine, plate, gcode)
    // Each filament's extruder (0-based) and nozzle, the left one for every filament on a printer with one.
    const extruderOf = (i: number) => (map ? Math.max(0, (map.maps[i] ?? 1) - 1) : 0)
    const nozzleOf = (i: number) => (map ? (map.nozzles[i] ?? extruderOf(i)) : 0)
    const diameterOf = (e: number) => machine.nozzleDiameters[e] ?? machine.nozzleDiameters[0] ?? 0.4
    const volumeOf = (e: number) => ((machine.nozzleVolumeTypes[e] ?? machine.nozzleVolumeTypes[0]) === 1 ? 'High Flow' : 'Standard')
    const nozzle = diameterOf(0)
    const volume = volumeOf(0)
    // The nozzles the plate prints with, once each, in nozzle order (Bambu Studio's `<nozzle>` entries).
    const usedNozzles = [...new Map(used.map((u) => [nozzleOf(u.id), extruderOf(u.id)] as const)).entries()].sort((a, b) => a[0] - b[0])
    return (
      `  <plate>\n${meta('index', index + 1)}` +
      meta('extruder_type', machine.extruderTypes.join(' ')) +
      meta('nozzle_volume_type', machine.nozzleVolumeTypes.join(' ')) +
      meta('printer_model_id', machine.printerModelId) +
      meta('nozzle_diameters', machine.nozzleDiameters.map(plain).join(',')) +
      meta('timelapse_type', machine.timelapseType) +
      (seconds !== undefined ? meta('prediction', seconds) : '') +
      (grams !== undefined ? meta('weight', grams) : '') +
      meta('first_layer_time', firstLayer.toFixed(6)) +
      meta('outside', Boolean(outside)) +
      meta('support_used', machine.supportUsed) +
      meta('label_object_enabled', ids.length > 0) +
      meta('enable_filament_dynamic_map', false) +
      meta('has_filament_switcher', false) +
      meta('filament_maps', (map?.maps ?? machine.filaments.map(() => 1)).join(' ')) +
      ids.map((id, k) => `    <object identify_id="${id}" name="${esc(names[k] ?? `Object ${k + 1}`)}" skipped="false" />\n`).join('') +
      used
        .map((u) => {
          const f = machine.filaments[u.id] ?? machine.filaments[0]!
          const e = extruderOf(u.id)
          return `    <filament id="${u.id + 1}" tray_info_idx="${esc(f.trayInfoIdx)}" type="${esc(f.type)}" color="${esc(f.color.toUpperCase())}" used_m="${fixed2(u.m)}" used_g="${fixed2(u.g)}" group_id="${nozzleOf(u.id)}" nozzle_diameter="${fixed2(diameterOf(e))}" volume_type="${volumeOf(e)}" used_for_object="true" used_for_support="${machine.supportUsed}"/>\n`
        })
        .join('') +
      (map
        ? usedNozzles.map(([id, e]) => `    <nozzle id="${id}" extruder_id="${e + 1}" nozzle_diameter="${plain(diameterOf(e))}" volume_type="${volumeOf(e)}"/>\n`).join('')
        : used.length
          ? `    <nozzle id="0" extruder_id="1" nozzle_diameter="${plain(nozzle)}" volume_type="${volume}"/>\n`
          : '') +
      `  </plate>\n`
    )
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="${CLIENT_VERSION}"/>\n  </header>\n${body.join('')}</config>\n`
}

/**
 * The slice format version the file declares, as Orca 2.4.2 writes it (`convert_to_full_version`). Bambu Lab
 * firmware and Bambu Handy read the slicer version from this header item, so the value is the one Orca sends.
 */
const CLIENT_VERSION = '02.06.00.51'

/**
 * The G-code without its thumbnail blocks. The pictures go into the 3MF as Metadata/plate_N.png, which is what the
 * printer and Bambu Studio show, and Orca writes plate_N.gcode without them (`GCode::_do_export` exports thumbnails
 * only for printers other than Bambu Lab's), so the file the printer runs is the same size as Orca's.
 */
export function withoutThumbnails(gcode: string): string {
  const end = gcode.lastIndexOf('; THUMBNAIL_BLOCK_END', 4_000_000)
  if (end < 0) return gcode
  const cut = gcode.indexOf('\n', end) + 1 || gcode.length
  return gcode.slice(0, cut).replace(/^; THUMBNAIL_BLOCK_START\r?\n[\s\S]*?^; THUMBNAIL_BLOCK_END\r?\n(?:\r?\n)?/gm, '') + gcode.slice(cut)
}

/**
 * The PNG thumbnails the engine wrote at the top of the G-code (`; thumbnail begin WxH SIZE`, base64 rows), largest
 * first. Other formats (JPG, QOI) are left out: the 3MF names its thumbnails .png.
 */
export function gcodeThumbnails(gcode: string): { w: number; h: number; png: Uint8Array }[] {
  // Each size has its own THUMBNAIL_BLOCK_START and _END, all near the top: read up to the last end in the first 4 MB.
  const end = gcode.lastIndexOf('; THUMBNAIL_BLOCK_END', 4_000_000)
  const head = end >= 0 ? gcode.slice(0, end) : gcode.slice(0, 4_000_000)
  const out: { w: number; h: number; png: Uint8Array }[] = []
  for (const m of head.matchAll(/^; thumbnail begin (\d+)x(\d+) \d+\r?\n([\s\S]*?)^; thumbnail end/gm)) {
    const b64 = m[3]!.split('\n').map((l) => l.replace(/^;\s?/, '').trim()).join('')
    try {
      const bin = atob(b64)
      const png = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) png[i] = bin.charCodeAt(i)
      if (png[0] === 0x89 && png[1] === 0x50) out.push({ w: Number(m[1]), h: Number(m[2]), png })
    } catch {
      // A block that is not base64 is not a thumbnail.
    }
  }
  return out.sort((a, b) => b.w * b.h - a.w * a.h)
}

/**
 * Metadata/plate_N.json as Orca writes it (`PlateBBoxData` in GCode/ThumbnailData.hpp, version 2): the box around
 * every object's extrusions and one entry per object with its box, area, layer height and name. The ids are the
 * label ids (the same as identify_id in slice_info.config); the area is the box's.
 */
export function plateJson(footprints: readonly PlateFootprint[], gcode: string, machine: SliceMachine, bedType: string | undefined, byObject = false): string {
  const used = usedFilaments(gcode).map((u) => u.id)
  const all = footprints.length
    ? footprints.reduce<[number, number, number, number]>((a, { box }) => [Math.min(a[0], box[0]), Math.min(a[1], box[1]), Math.max(a[2], box[2]), Math.max(a[3], box[3])], [Infinity, Infinity, -Infinity, -Infinity])
    : [0, 0, 0, 0]
  return JSON.stringify({
    bbox_all: all,
    bbox_objects: footprints.map((o) => ({ area: Number(((o.box[2] - o.box[0]) * (o.box[3] - o.box[1])).toFixed(4)), bbox: o.box, id: Number(o.id), layer_height: machine.layerHeight, name: o.name })),
    bed_type: BED_TYPE_KEYS[bedType ?? ''] ?? 'textured_plate',
    filament_colors: used.map((i) => (machine.filaments[i] ?? machine.filaments[0]!).color.toUpperCase()),
    filament_ids: used,
    first_extruder: used[0] ?? 0,
    first_layer_time: gcodeSeconds(gcode, 'estimated first layer printing time \\(normal mode\\)') ?? 0,
    is_seq_print: byObject,
    nozzle_diameter: machine.nozzleDiameters[0] ?? 0.4,
    version: 2,
  })
}

export interface ProjectInput {
  plates: readonly PlateMeta[]
  bed: { widthMm: number; depthMm: number }
  /** Orca keys and values (as Orca writes them) for project_settings.config. */
  settings: Record<string, unknown>
  /** Per-object setting overrides by object source id. */
  objectSettings?: Record<string, Record<string, unknown>>
  application?: string
  /** Pause, color change and custom G-code marks per plate index (0-based), written as Orca's custom_gcode_per_layer.xml. */
  layerMarks?: Record<number, { z: number; kind: 'pause' | 'color_change' | 'custom'; gcode?: string }[]>
  /** Sliced G-code per plate index (0-based), for a .gcode.3mf. */
  gcode?: Record<number, string>
  /**
   * SlicerX metadata for an .sx3mf (packages/sx3mf/SPEC.md, "The model part"): the model's id, its
   * creator's id and the id of the person exporting (empty when signed out). Geometry is unchanged.
   */
  sx?: { modelId?: string; creatorId?: string; exportedBy: string }
  /** The project's named values (cad/values.ts), written as Metadata/slicerx_values.json. */
  namedValues?: readonly NamedValue[]
}

const SX_NS = 'https://slicerx.app/schemas/sx3mf/2026'

/** Plates sit side by side in the project's build space, as in Bambu Studio and OrcaSlicer. */
function plateOffset(index: number, count: number, bed: { widthMm: number; depthMm: number }): [number, number] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const gap = 1.2
  return [(index % cols) * bed.widthMm * gap, -Math.floor(index / cols) * bed.depthMm * gap]
}

/** Roughly how many bytes of XML the meshes take. */
function meshBytes(input: ProjectInput): number {
  let n = 0
  for (const pl of input.plates) for (const o of pl.objects) for (const m of [...o.parts, ...(o.volumes ?? []).map((v) => v.part)]) n += m.positions.length * 7 + m.indices.length * 6
  return n
}

/** Past this, meshes go one file per object, as Bambu Studio writes them: one file would be too big to read back. */
const SPLIT_BYTES = 32 * 1024 * 1024
const MODEL_OPEN = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">'

/** Orca's CustomGCode::Type numbers: color change 0, pause 1, custom 4. */
const MARK_TYPE = { color_change: 0, pause: 1, custom: 4 } as const

/** Metadata/custom_gcode_per_layer.xml as Orca writes it (bbs_3mf.cpp, _add_custom_gcode_per_print_z_file_to_archive), or '' without marks. */
function marksXml(marks: ProjectInput['layerMarks']): string {
  const plates = Object.entries(marks ?? {}).filter(([, list]) => list.length > 0)
  if (plates.length === 0) return ''
  const body = plates
    .map(([i, list]) => {
      const layers = list
        .map((m) => {
          const extra = m.kind === 'custom' ? (m.gcode ?? '') : ''
          return `<layer top_z="${m.z}" type="${MARK_TYPE[m.kind]}" extruder="1" color="" extra="${esc(extra)}" gcode="${esc(extra)}"/>`
        })
        .join('\n')
      return `<plate>\n<plate_info id="${Number(i) + 1}"/>\n${layers}\n<mode value="SingleExtruder"/>\n</plate>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n${body}\n</custom_gcodes_per_layer>`
}

/**
 * Metadata/slicerx_dimensions.json (docs/cad-engine.md, "The dimensions part, exactly"): every kept
 * dimension with its anchors' `object` set to the 3MF object id. Null when there are none, so the part
 * is left out. Dimensions on an object that is not written are dropped; plane triangle hints are too.
 */
export function dimensionsJson(objects: readonly Pick<PlateEntry, 'id' | 'dimensions'>[], fileIds: ReadonlyMap<string, number>): string | null {
  const anchor = (a: DimensionAnchor): DimensionAnchor | null => {
    const id = fileIds.get(a.object)
    if (id === undefined) return null
    const { triangles: _hint, ...feature } = a.feature as typeof a.feature & { triangles?: number[] }
    return { object: String(id), pick: { triangle: a.pick.triangle, at: a.pick.at }, snapMm: a.snapMm, feature: feature as DimensionAnchor['feature'] }
  }
  const out: Dimension[] = []
  for (const o of objects) {
    for (const d of o.dimensions ?? []) {
      const a = anchor(d.a)
      const b = d.b ? anchor(d.b) : null
      if (!a || (d.b && !b)) continue
      out.push({ id: d.id, kind: d.kind, a, ...(b ? { b } : {}), ...(d.value !== undefined ? { value: d.value } : {}) })
    }
  }
  return out.length ? JSON.stringify({ version: 1, dimensions: out }, null, 2) : null
}

export function projectFiles(input: ProjectInput, splitAt = SPLIT_BYTES): ZipEntry[] {
  const split = meshBytes(input) > splitAt
  const objectFiles: ZipEntry[] = []
  const resources: string[] = []
  const build: string[] = []
  const objectsCfg: string[] = []
  const platesCfg: string[] = []
  const brimLines: string[] = []
  const rangesCfg: string[] = []
  const fileIds = new Map<string, number>()
  let nextId = 1
  const thumbs = new Map<number, ReturnType<typeof gcodeThumbnails>>()
  const machine = sliceMachine(input.settings)
  // The plate counts from the printable area's front left corner; Orca places objects on the machine.
  const [ax, ay] = areaOrigin(input.settings['printable_area'])
  input.plates.forEach((plate, pi) => {
    const [ox, oy] = plateOffset(pi, input.plates.length, input.bed)
    const instances: string[] = []
    // A sliced plate's instances carry the id its G-code labels them with (Orca's identify_id), printing objects in order.
    const labelIds = input.gcode?.[pi] !== undefined ? gcodeLabelIds(input.gcode[pi]!) : []
    let printing = 0
    for (const obj of plate.objects) {
      const partIds: number[] = []
      const meshObjects: string[] = []
      for (const [pi, part] of obj.parts.entries()) {
        const id = nextId++
        partIds.push(id)
        meshObjects.push(`<object id="${id}" type="model">${meshXml(part, obj.paint?.[pi])}</object>`)
      }
      // Negative volumes and support blockers or enforcers are parts of the object with their own subtype, as Orca writes them.
      const volParts: { id: number; name: string; subtype: string; settings?: Record<string, unknown> }[] = []
      for (const v of obj.volumes ?? []) {
        const id = nextId++
        partIds.push(id)
        volParts.push({ id, name: v.name, subtype: VOLUME_SUBTYPE[v.role], ...(v.settings ? { settings: v.settings } : {}) })
        meshObjects.push(`<object id="${id}" type="model">${meshXml(bake(v.part, v.local))}</object>`)
      }
      const objId = nextId++
      fileIds.set(obj.id, objId)
      if (split) {
        const path = `3D/Objects/object_${objId}.model`
        objectFiles.push({ name: path, data: `${MODEL_OPEN}<resources>${meshObjects.join('')}</resources><build/></model>` })
        resources.push(`<object id="${objId}" type="model"><components>${partIds.map((id) => `<component p:path="/${path}" objectid="${id}"/>`).join('')}</components></object>`)
      } else {
        resources.push(...meshObjects, `<object id="${objId}" type="model"><components>${partIds.map((id) => `<component objectid="${id}"/>`).join('')}</components></object>`)
      }
      const t = [...obj.transform]
      t[12] = (t[12] ?? 0) + ox + ax
      t[13] = (t[13] ?? 0) + oy + ay
      const pts = obj.brimPoints
      // Settings by height (layer_config_ranges.xml), objects numbered from 1 in build order as for the brim ears.
      if (obj.layerRanges?.length) rangesCfg.push(`<object id="${build.length + 1}">${obj.layerRanges.map((r) => `<range min_z="${f(r.minZ)}" max_z="${f(r.maxZ)}">${Object.entries(r.settings).map(([k, v]) => `<option opt_key="${esc(k)}">${esc(String(v))}</option>`).join('')}</range>`).join('')}</object>`)
      if (pts?.length) brimLines.push(`object_id=${build.length + 1}|${pts.map((q) => q.map(f).join(' ')).join(' ')}`)
      build.push(`<item objectid="${objId}" transform="${transformAttr(t)}" printable="${obj.printable === false ? 0 : 1}"/>`)
      const own = input.objectSettings?.[obj.instanceOf ?? obj.id] ?? {}
      const src = input.sx ? obj.source : undefined
      objectsCfg.push(
        `<object id="${objId}"><metadata key="name" value="${esc(obj.name)}"/><metadata key="extruder" value="${obj.parts[0] ? (obj.slotOverrides?.[obj.parts[0].name] ?? obj.parts[0].slot) : 1}"/>` +
          (src?.modelId ? `<metadata key="sx:Listing" value="${esc(src.modelId)}"/>` : '') +
          (src?.creatorId ? `<metadata key="sx:Creator" value="${esc(src.creatorId)}"/>` : '') +
          Object.entries(own).map(([k, v]) => `<metadata key="${esc(k)}" value="${esc(String(v))}"/>`).join('') +
          obj.parts.map((p, i) => `<part id="${partIds[i]}" subtype="normal_part"><metadata key="name" value="${esc(p.name)}"/><metadata key="extruder" value="${obj.slotOverrides?.[p.name] ?? p.slot}"/>${modifierMeta(obj.partSettings?.[p.name])}</part>`).join('') +
          volParts.map((v) => `<part id="${v.id}" subtype="${v.subtype}"><metadata key="name" value="${esc(v.name)}"/><metadata key="extruder" value="1"/>${modifierMeta(v.settings)}</part>`).join('') +
          `</object>`,
      )
      const identify = obj.printable !== false ? labelIds[printing++] : undefined
      instances.push(`<model_instance><metadata key="object_id" value="${objId}"/><metadata key="instance_id" value="0"/>${identify ? `<metadata key="identify_id" value="${identify}"/>` : ''}</model_instance>`)
    }
    const s = plate.settings
    const gcode = input.gcode?.[pi]
    const plateMap = plateFilamentMap(machine, plate, gcode)
    const shots = gcode !== undefined ? gcodeThumbnails(gcode) : []
    if (shots.length) thumbs.set(pi, shots)
    platesCfg.push(
      `<plate><metadata key="plater_id" value="${pi + 1}"/><metadata key="plater_name" value="${esc(plate.name)}"/><metadata key="locked" value="false"/>` +
        (s.bedType ? `<metadata key="curr_bed_type" value="${BED_TYPE_NAMES[s.bedType] ?? ''}"/>` : '') +
        (s.sequence ? `<metadata key="print_sequence" value="${s.sequence === 'by-object' ? 'by object' : 'by layer'}"/>` : '') +
        (s.filamentOrder ? `<metadata key="first_layer_print_sequence" value="${s.filamentOrder.join(',')}"/>` : '') +
        (plateMap ? `<metadata key="filament_map_mode" value="${plateMap.mode}"/><metadata key="filament_maps" value="${plateMap.maps.join(' ')}"/>` : '') +
        (gcode !== undefined ? `<metadata key="gcode_file" value="Metadata/plate_${pi + 1}.gcode"/>` : '') +
        (shots.length ? `<metadata key="thumbnail_file" value="Metadata/plate_${pi + 1}.png"/>` : '') +
        (gcode !== undefined ? `<metadata key="pattern_bbox_file" value="Metadata/plate_${pi + 1}.json"/>` : '') +
        instances.join('') +
        `</plate>`,
    )
  })
  const app = esc(input.application ?? appName())
  const sx = input.sx
  const sxMeta = sx
    ? (sx.modelId ? `<metadata name="sx:Listing">${esc(sx.modelId)}</metadata>` : '') +
      (sx.creatorId ? `<metadata name="sx:Creator">${esc(sx.creatorId)}</metadata>` : '') +
      `<metadata name="sx:ExportedBy">${esc(sx.exportedBy)}</metadata>`
    : ''
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${split ? ' xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"' : ''}${sx ? ` xmlns:sx="${SX_NS}"` : ''}>` +
    `<metadata name="Application">${app}</metadata><metadata name="Title">${esc(input.plates[0]?.objects[0]?.name ?? 'Project')}</metadata>${sxMeta}` +
    `<resources>${resources.join('')}</resources><build>${build.join('')}</build></model>`
  // The first sliced plate's picture is the file's cover, under the relationship types Bambu Studio and Orca use
  // (bbs_3mf.cpp, `_add_relationships_file_to_archive`).
  const coverIndex = [...thumbs.keys()].sort((a, b) => a - b)[0]
  const cover = coverIndex !== undefined
    ? `<Relationship Target="/Metadata/plate_${coverIndex + 1}.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>` +
      `<Relationship Target="/Metadata/plate_${coverIndex + 1}.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>` +
      `<Relationship Target="/Metadata/plate_${coverIndex + 1}_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>`
    : ''
  const files: ZipEntry[] = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="gcode" ContentType="text/x.gcode"/><Default Extension="config" ContentType="text/xml"/><Default Extension="md5" ContentType="text/plain"/><Default Extension="json" ContentType="application/json"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${cover}</Relationships>` },
    { name: '3D/3dmodel.model', data: model },
    ...(split
      ? [
          { name: '3D/_rels/3dmodel.model.rels', data: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${objectFiles.map((f, i) => `<Relationship Target="/${f.name}" Id="rel-${i + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join('')}</Relationships>` },
          ...objectFiles,
        ]
      : []),
    { name: 'Metadata/model_settings.config', data: `<?xml version="1.0" encoding="UTF-8"?>\n<config>${objectsCfg.join('')}${platesCfg.join('')}</config>` },
    { name: 'Metadata/project_settings.config', data: JSON.stringify(input.settings, null, 2) },
  ]
  if (rangesCfg.length) files.push({ name: 'Metadata/layer_config_ranges.xml', data: `<?xml version="1.0" encoding="utf-8"?>\n<objects>${rangesCfg.join('')}</objects>\n` })
  if (brimLines.length) files.push({ name: 'Metadata/brim_ear_points.txt', data: `brim_points_format_version=0\n${brimLines.join('\n')}\n` })
  const dims = dimensionsJson(input.plates.flatMap((p) => p.objects), fileIds)
  if (dims) files.push({ name: 'Metadata/slicerx_dimensions.json', data: dims })
  files.push(...historyFiles(input.plates.flatMap((p) => p.objects), fileIds))
  const values = valuesJson(input.namedValues ?? [])
  if (values) files.push({ name: 'Metadata/slicerx_values.json', data: values })
  const marks = marksXml(input.layerMarks)
  if (marks) files.push({ name: 'Metadata/custom_gcode_per_layer.xml', data: marks })
  const sliced = Object.entries(input.gcode ?? {}).map(([i, gcode]) => {
    const plate = input.plates[Number(i)]
    const names = (plate?.objects ?? []).filter((o) => o.printable !== false).map((o) => o.name)
    // Each labeled object's footprint, named as slice_info names it (the label ids run in plate order).
    const ids = gcodeLabelIds(gcode)
    const footprints: PlateFootprint[] = plateObjectsFromGcode(gcode).map((o) => {
      const k = ids.indexOf(o.id)
      const [a, , c] = o.polygon
      return { id: o.id, name: names[k] ?? o.name, box: [a![0], a![1], c![0], c![1]] }
    })
    return { index: Number(i), gcode, names, footprints, outside: outsideOf(footprints, machine.printableArea), plate }
  })
  if (sliced.length) files.push({ name: 'Metadata/slice_info.config', data: sliceInfoXml(sliced, machine) })
  for (const { index, gcode, footprints, plate } of sliced) {
    const n = index + 1
    // Orca writes the digest in capitals (bbs_3mf.cpp, "%02X").
    const run = withoutThumbnails(gcode)
    files.push({ name: `Metadata/plate_${n}.gcode`, data: run }, { name: `Metadata/plate_${n}.gcode.md5`, data: md5Hex(new TextEncoder().encode(run)).toUpperCase() })
    files.push({ name: `Metadata/plate_${n}.json`, data: plateJson(footprints, gcode, machine, plate?.settings.bedType, plateSequence(plate, input.settings) === 'by-object') })
    const shots = thumbs.get(index) ?? []
    if (shots.length) files.push({ name: `Metadata/plate_${n}.png`, data: shots[0]!.png }, { name: `Metadata/plate_${n}_small.png`, data: shots[shots.length - 1]!.png })
  }
  if (sliced.length) {
    files.push({
      name: 'Metadata/_rels/model_settings.config.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sliced.map(({ index }, k) => `<Relationship Target="/Metadata/plate_${index + 1}.gcode" Id="rel-${k + 1}" Type="http://schemas.bambulab.com/package/2021/gcode"/>`).join('')}</Relationships>`,
    })
  }
  return files
}

export function writeProject(input: ProjectInput): Uint8Array {
  return zip(projectFiles(input))
}

/** Same file, deflated: what a save writes. */
export function writeProjectCompressed(input: ProjectInput): Promise<Uint8Array> {
  return zipCompressed(projectFiles(input))
}
