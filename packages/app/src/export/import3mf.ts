// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads a 3MF project (SlicerX .sx3mf, Bambu Studio or OrcaSlicer) into objects, parts and volumes. The
// part subtypes of Orca's 3MF layout decide what a part is: normal parts print, negative parts cut,
// support blockers and enforcers steer support. The archive is untrusted: entry count, sizes and names
// are capped before anything is inflated.
import type { NamedValue } from '../cad/value-names'
import { parseValues } from './values-file'
import type { MeshPart } from '@slicerx/contracts'
import { MarkReadError, readVaultMarks, type VaultMark, type VaultMarks } from '@slicerx/contracts/sx3mf-marks'
import type { Dimension, DimensionAnchor, Feature } from '../geom/cad'
import type { History } from '../cad/history/model'
import { historyNewer, parseHistories } from './history-read'
import type { VolumeRole } from '../state/store'
import { areaOrigin, areaSize } from '../plate/bed-origin'
import { bounds } from '../plate/transform'
import { ProjectReadError, unzipEntries } from './unzip'
import type { Mat, PaintOfPart, ScannedModel, ScannedObject } from './model-scan'
import { scanProject, type ScannedProject } from './project-scan'
import { scanProjectInWorker } from './project-worker-client'

export { ProjectReadError, unzipEntries, type ZipLimits } from './unzip'
export type { PaintOfPart } from './model-scan'

export interface ImportedVolume {
  name: string
  role: VolumeRole
  /** In the object's coordinates. */
  part: MeshPart
  /** A modifier's settings as the file wrote them (Orca's strings). Untrusted: take them through project-settings.ts. */
  rawSettings?: Record<string, string>
}


export interface ImportedObject {
  name: string
  parts: MeshPart[]
  /** Paint by part index. */
  paint?: Record<number, PaintOfPart>
  /** False when the project leaves the object out of the print. */
  printable?: boolean
  volumes: ImportedVolume[]
  /** Setting entries a normal part carries in the file, by part name (Orca's strings). Untrusted: take them through project-settings.ts. */
  rawPartSettings?: Record<string, Record<string, string>>
  /** 4x4 column-major, mm, on the plate. */
  transform: number[]
  /** Painted brim ears from Metadata/brim_ear_points.txt, [x, y, z, headRadius] in the object's own space. */
  brimPoints?: [number, number, number, number][]
  source?: { modelId?: string; creatorId?: string }
  /** Settings by height from Metadata/layer_config_ranges.xml, as the file has them. Untrusted: take them through plate/layer-ranges.ts. */
  layerRanges?: import('../plate/layer-ranges').LayerRange[]
  /** The object's id in 3D/3dmodel.model, which kept dimensions refer to. */
  fileId: string
}

export interface ImportedPlate {
  name: string
  /** Absent when the plate follows the project's print sequence. */
  sequence?: 'by-layer' | 'by-object'
  /** A filament map set by hand (`filament_map_mode` Manual): the extruder of each filament, 1 the left. */
  nozzleMap?: number[]
  objects: ImportedObject[]
  /** Pause, color change and custom G-code from Metadata/custom_gcode_per_layer.xml. Untrusted: custom text is checked before it is used. */
  marks?: { z: number; kind: 'pause' | 'color_change' | 'custom'; gcode?: string }[]
}

export interface ImportedProject {
  plates: ImportedPlate[]
  /** filament_colour from the project settings. */
  colors: string[]
  /** Metadata/project_settings.config as written, Orca's string values; a PrusaSlicer project's Metadata/Slic3r_PE.config mapped to the same form. Untrusted: go through project-settings.ts. */
  settings: Record<string, unknown>
  /** Which app's config the settings were read from. */
  settingsFrom: 'orca' | 'prusaslicer'
  /** Kept dimensions from Metadata/slicerx_dimensions.json; anchors name objects by `fileId`. */
  dimensions: Dimension[]
  /** CAD histories from Metadata/slicerx_history.json, by `fileId`. */
  histories: Map<string, History>
  /** Named values from Metadata/slicerx_values.json. */
  namedValues: NamedValue[]
  /** Why the histories did not open, when a newer SlicerX saved them. */
  historyNote?: string
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isVec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(isNum)
const FEATURE_KEYS: Record<Feature['kind'], [string, (v: unknown) => boolean][]> = {
  point: [['at', isVec3]],
  edge: [['a', isVec3], ['b', isVec3]],
  circle: [['center', isVec3], ['axis', isVec3], ['radius', isNum], ['sweepDeg', isNum]],
  plane: [['point', isVec3], ['normal', isVec3], ['areaMm2', isNum]],
  cylinder: [['point', isVec3], ['axis', isVec3], ['radius', isNum]],
  surface: [['at', isVec3], ['normal', isVec3]],
}

function readFeature(v: unknown): Feature | null {
  if (!v || typeof v !== 'object') return null
  const f = v as Record<string, unknown>
  const keys = FEATURE_KEYS[f['kind'] as Feature['kind']]
  if (!keys || !keys.every(([k, ok]) => ok(f[k]))) return null
  // Only the fields the kind has; a plane's triangle hint is dropped.
  return Object.fromEntries([['kind', f['kind']], ...keys.map(([k]) => [k, f[k]])]) as Feature
}

function readAnchor(v: unknown): DimensionAnchor | null {
  if (!v || typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  const pick = a['pick'] as Record<string, unknown> | undefined
  const feature = readFeature(a['feature'])
  if (typeof a['object'] !== 'string' || !pick || !Number.isInteger(pick['triangle']) || (pick['triangle'] as number) < 0 || !isVec3(pick['at']) || !feature) return null
  return { object: a['object'], pick: { triangle: pick['triangle'] as number, at: pick['at'] }, snapMm: isNum(a['snapMm']) ? a['snapMm'] : 0, feature }
}

/**
 * Metadata/slicerx_dimensions.json (docs/cad-engine.md). Untrusted: a version above 1 is ignored,
 * and a dimension with a bad field or an anchor on a missing object is dropped. At most 1000.
 */
export function parseDimensions(bytes: Uint8Array | undefined, objectIds: ReadonlySet<string>): Dimension[] {
  if (!bytes || bytes.length > 8 * 1024 * 1024) return []
  let j: unknown
  try {
    j = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return []
  }
  if (!j || typeof j !== 'object' || (j as { version?: unknown }).version !== 1) return []
  const list = (j as { dimensions?: unknown }).dimensions
  if (!Array.isArray(list)) return []
  const kinds = new Set(['distance', 'angle', 'radius', 'diameter', 'length'])
  const out: Dimension[] = []
  const seen = new Set<string>()
  for (const raw of list.slice(0, 1000)) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as Record<string, unknown>
    const id = d['id']
    const kind = d['kind']
    if (typeof id !== 'string' || !id || id.length > 64 || seen.has(id) || typeof kind !== 'string' || !kinds.has(kind)) continue
    const two = kind === 'distance' || kind === 'angle'
    const a = readAnchor(d['a'])
    const b = two ? readAnchor(d['b']) : null
    if (!a || !objectIds.has(a.object) || (two && (!b || !objectIds.has(b.object)))) continue
    seen.add(id)
    out.push({ id, kind: kind as Dimension['kind'], a, ...(b ? { b } : {}), ...(isNum(d['value']) ? { value: d['value'] } : {}) })
  }
  return out
}

const ROLE: Record<string, VolumeRole> = { negative_part: 'negative', support_blocker: 'support_blocker', support_enforcer: 'support_enforcer', modifier_part: 'modifier' }

/** Part metadata keys that are not settings. */
const PART_META = new Set(['name', 'matrix', 'extruder', 'volume_type', 'mesh_stat', 'source_file', 'source_object_id', 'source_volume_id', 'source_offset_x', 'source_offset_y', 'source_offset_z', 'source_in_inches', 'source_in_meters'])

function bakeMesh(p: MeshPart, m: Mat | null, name: string, slot: number): MeshPart {
  if (!m) return { ...p, name, slot }
  const out = new Float32Array(p.positions.length)
  for (let i = 0; i + 2 < p.positions.length; i += 3) {
    const x = p.positions[i]!
    const y = p.positions[i + 1]!
    const z = p.positions[i + 2]!
    out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
    out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
  }
  return { name, slot, positions: out, indices: p.indices }
}

/** The triangles `first` to `last` (inclusive) of a mesh as a part of their own, with only the vertices they use. */
function subMesh(p: MeshPart, first: number, last: number, name: string, slot: number): MeshPart | null {
  const triCount = p.indices.length / 3
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= triCount) return null
  const remap = new Map<number, number>()
  const pos: number[] = []
  const idx = new Uint32Array((last - first + 1) * 3)
  for (let t = first, o = 0; t <= last; t++) {
    for (let c = 0; c < 3; c++, o++) {
      const v = p.indices[t * 3 + c]!
      let n = remap.get(v)
      if (n === undefined) {
        n = remap.size
        remap.set(v, n)
        pos.push(p.positions[v * 3]!, p.positions[v * 3 + 1]!, p.positions[v * 3 + 2]!)
      }
      idx[o] = n
    }
  }
  return { name, slot, positions: new Float32Array(pos), indices: idx }
}

/** PrusaSlicer's volume types, as the roles Orca's subtypes give. A model part is a normal part. */
const PRUSA_ROLE: Record<string, VolumeRole> = { NegativeVolume: 'negative', ParameterModifier: 'modifier', SupportBlocker: 'support_blocker', SupportEnforcer: 'support_enforcer' }

/** Volume and object metadata in Slic3r_PE_model.config that is not a setting. */
const PRUSA_META = new Set(['name', 'volume_type', 'modifier', 'matrix', 'extruder', 'source_file', 'source_object_id', 'source_volume_id', 'source_offset_x', 'source_offset_y', 'source_offset_z', 'source_in_inches', 'source_in_meters', 'mesh_stat', 'text_configuration', 'shape_configuration', 'svg', 'cut_id', 'cut_info'])

interface PrusaVolume {
  first: number
  last: number
  name?: string
  type: string
  extruder?: number
  /** Orca-format settings from the volume's Prusa keys. */
  settings: Record<string, string>
}

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new ProjectReadError('The 3MF model file is not valid XML.')
  return doc
}

const kids = (el: Element, tag: string): Element[] => [...el.children].filter((c) => c.localName === tag)

/** Column-major 4x4 product a * b (b applied first); null is the identity. */
function mul(a: Mat | null, b: Mat | null): Mat | null {
  if (!a) return b
  if (!b) return a
  const out = new Array<number>(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!
  return out
}

/** How deep components may nest, and how many meshes one object may place, before the file is refused. */
const MAX_COMPONENT_DEPTH = 32
const MAX_COMPONENT_MESHES = 10_000

/**
 * The meshes an object of components places, however deep its components nest, each with its transform into the
 * object's space (null when nothing along the way moves it) and the id of the object that holds the mesh. A
 * component's object is looked up in the model part its path names, or without a path in the part the component
 * itself is in. A component that names a missing object, contains itself, or nests too deep refuses the file instead
 * of opening part of it.
 */
function meshLeaves(model: ScannedModel, obj: ScannedObject, modelAt: (path: string | undefined, from: ScannedModel) => ScannedModel): { obj: ScannedObject; id: string; matrix: Mat | null }[] {
  const out: { obj: ScannedObject; id: string; matrix: Mat | null }[] = []
  // The objects on the way down, to see a component that contains itself.
  const open = new Set<ScannedObject>([obj])
  const walk = (m: ScannedModel, o: ScannedObject, matrix: Mat | null, depth: number) => {
    if (depth > MAX_COMPONENT_DEPTH) throw new ProjectReadError('The 3MF nests its components too deep.')
    for (const c of o.components) {
      const part = modelAt(c.path, m)
      const child = part.objects.get(c.objectId)
      if (!child) throw new ProjectReadError('The 3MF has a component that points at an object it does not have.')
      if (open.has(child)) throw new ProjectReadError('The 3MF has a component that contains itself.')
      const at = mul(matrix, c.transform)
      if (child.mesh || !child.components.length) {
        out.push({ obj: child, id: c.objectId, matrix: at })
        if (out.length > MAX_COMPONENT_MESHES) throw new ProjectReadError('The 3MF places too many meshes in one object.')
        continue
      }
      open.add(child)
      walk(part, child, at, depth + 1)
      open.delete(child)
    }
  }
  walk(model, obj, null, 0)
  return out
}

function projectOrigin(config: Uint8Array | undefined): readonly [number, number] {
  return areaOrigin(projectArea(config))
}

/** The project's printable_area, as its settings carry it. */
function projectArea(config: Uint8Array | undefined): unknown {
  if (!config) return undefined
  try {
    const j: unknown = JSON.parse(new TextDecoder().decode(config))
    return j !== null && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>)['printable_area'] : undefined
  } catch {
    return undefined
  }
}

/**
 * Bambu Studio and Orca keep where a part sits in its object in the component's transform, in the model's own
 * coordinates, so a part can sit far from its object's origin (m.3mf's at 128, 131 with the object at -53, 128). Models
 * here are stored centered on X and Y, so that offset moves into the object's placement: the position fields then read
 * where the object is, and rotate and scale turn it about itself. Where it prints does not change. Returns the offset.
 */
function centerObject(parts: MeshPart[], volumes: ImportedVolume[], t: number[], ears: [number, number, number, number][] | undefined): [number, number] | null {
  const b = bounds(parts, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  if (!b) return null
  const cx = (b.min[0] + b.max[0]) / 2
  const cy = (b.min[1] + b.max[1]) / 2
  if (Math.abs(cx) < 1e-3 && Math.abs(cy) < 1e-3) return null
  const shift = (p: MeshPart): MeshPart => {
    const out = new Float32Array(p.positions)
    for (let i = 0; i + 2 < out.length; i += 3) {
      out[i] = out[i]! - cx
      out[i + 1] = out[i + 1]! - cy
    }
    return { ...p, positions: out }
  }
  parts.splice(0, parts.length, ...parts.map(shift))
  for (const v of volumes) v.part = shift(v.part)
  if (ears) for (const e of ears) {
    e[0] -= cx
    e[1] -= cy
  }
  t[12] = t[12]! + t[0]! * cx + t[4]! * cy
  t[13] = t[13]! + t[1]! * cx + t[5]! * cy
  t[14] = t[14]! + t[2]! * cx + t[6]! * cy
  return [cx, cy]
}

function plateOffset(index: number, count: number, bed: { widthMm: number; depthMm: number }): [number, number] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const gap = 1.2
  return [(index % cols) * bed.widthMm * gap, -Math.floor(index / cols) * bed.depthMm * gap]
}

/** Metadata/brim_ear_points.txt: an optional `brim_points_format_version=` line, then `object_id=N|x y z r x y z r ...` per build item (1-based). Untrusted: bad numbers and huge lists are dropped. */
export function parseBrimEars(bytes: Uint8Array | undefined): Map<number, [number, number, number, number][]> {
  const out = new Map<number, [number, number, number, number][]>()
  if (!bytes) return out
  for (const line of new TextDecoder().decode(bytes).split(/\r?\n/)) {
    const bar = line.indexOf('|')
    const m = /^object_id=(\d+)$/.exec(bar < 0 ? '' : line.slice(0, bar).trim())
    if (!m) continue
    const nums = line.slice(bar + 1).trim().split(/\s+/).map(Number)
    const pts: [number, number, number, number][] = []
    for (let i = 0; i + 3 < nums.length && pts.length < 2000; i += 4) {
      const q = nums.slice(i, i + 4) as [number, number, number, number]
      if (q.every(Number.isFinite) && q[3] > 0 && q[3] <= 50) pts.push(q)
    }
    if (pts.length) out.set(Number(m[1]), pts)
  }
  return out
}

/** Reads project bytes. Throws ProjectReadError with a plain message for anything it cannot use. */
/** Where the Vault marks are: every model part (a mark there covers the whole file) and the per object settings files. */
const MARKED_SETTINGS = ['Metadata/model_settings.config', 'Metadata/Slic3r_PE_model.config']

/**
 * The Vault marks of an unzipped 3MF, read as XML (packages/contracts/src/sx3mf-marks.ts), not by pattern. A mark in
 * any model part is a root mark; one in a settings file belongs to its object.
 */
export function vaultMarksOf(files: ReadonlyMap<string, Uint8Array>, modelRoot?: VaultMark): VaultMarks {
  // The marks of model parts read already (the project worker's), which `files` then leaves out.
  const out: VaultMarks = { root: { ...modelRoot }, objects: new Map() }
  const merge = (to: VaultMark, from: VaultMark) => {
    if (from.listing && !to.listing) to.listing = from.listing
    if (from.creator && !to.creator) to.creator = from.creator
  }
  const dec = new TextDecoder()
  try {
    for (const [name, bytes] of files) {
      if (!/\.model$/i.test(name)) continue
      merge(out.root, readVaultMarks(dec.decode(bytes)).root)
    }
    for (const name of MARKED_SETTINGS) {
      const bytes = files.get(name)
      if (!bytes) continue
      const m = readVaultMarks(dec.decode(bytes), true)
      merge(out.root, m.root)
      for (const [id, mark] of m.objects) {
        const to = out.objects.get(id) ?? {}
        merge(to, mark)
        out.objects.set(id, to)
      }
    }
  } catch (e) {
    if (e instanceof MarkReadError) throw new ProjectReadError(e.message)
    throw e
  }
  return out
}

function sourceOf(m: VaultMark): { modelId?: string; creatorId?: string } | undefined {
  return m.listing || m.creator ? { ...(m.listing ? { modelId: m.listing } : {}), ...(m.creator ? { creatorId: m.creator } : {}) } : undefined
}

/** The listing a 3MF names, for a file the engine opens itself: its root mark, or the first object's. Undefined when it names none or does not unzip. */
export async function vaultSourceOf(bytes: Uint8Array): Promise<{ modelId?: string; creatorId?: string } | undefined> {
  let files
  try {
    files = await unzipEntries(bytes)
  } catch {
    return undefined
  }
  const marks = vaultMarksOf(files)
  if (marks.root.listing) return sourceOf(marks.root)
  const first = [...marks.objects.values()].find((m) => m.listing)
  return first ? sourceOf({ ...marks.root, ...first }) : undefined
}

/** Centers the objects, as one group, on the bed, and sets each down on it (XY by the group's box, Z per object). */
function placeOnBed(objects: { parts: MeshPart[]; transform: number[] }[], bed: { widthMm: number; depthMm: number }): void {
  const boxes = objects.map((o) => bounds(o.parts, o.transform))
  const all = boxes.filter((b): b is NonNullable<typeof b> => b !== null)
  if (all.length === 0) return
  const lo = [Math.min(...all.map((b) => b.min[0])), Math.min(...all.map((b) => b.min[1]))]
  const hi = [Math.max(...all.map((b) => b.max[0])), Math.max(...all.map((b) => b.max[1]))]
  const dx = bed.widthMm / 2 - (lo[0]! + hi[0]!) / 2
  const dy = bed.depthMm / 2 - (lo[1]! + hi[1]!) / 2
  objects.forEach((o, i) => {
    o.transform[12] = o.transform[12]! + dx
    o.transform[13] = o.transform[13]! + dy
    const b = boxes[i]
    if (b) o.transform[14] = o.transform[14]! - b.min[2]
  })
}

/**
 * How far under the bed a slicer project's object may sit and still be one resting on it. Bambu Studio writes
 * transforms to three decimals, so a part turned on its side lands a few thousandths of a mm off (tangela's ring
 * part at -0.002 mm, from a rotation written as "0.001" instead of 0), and the slice would warn that part of the
 * plate is cut off at z = 0. An object set lower than this on purpose (sunk into the bed) stays where it is.
 */
const SETTLE_MM = 0.05

/** Sets an object that sits a hair under the bed, from the file's rounding, down on it. */
function settleOnBed(o: { parts: MeshPart[]; transform: number[] }): void {
  const b = bounds(o.parts, o.transform)
  if (b && b.min[2] < 0 && b.min[2] > -SETTLE_MM) o.transform[14] = o.transform[14]! - b.min[2]
}

/**
 * Inflates and scans a 3MF project: in the project worker when the page can start one, else here. The caller keeps
 * its bytes (the worker gets a copy).
 */
export function scanProjectFile(bytes: Uint8Array): Promise<ScannedProject & { parsedIn: 'worker' | 'page' }> {
  if (typeof Worker === 'undefined') return scanProject(bytes).then((p) => ({ ...p, parsedIn: 'page' as const }))
  return scanProjectInWorker(bytes).then((p) => ({ ...p, parsedIn: 'worker' as const }))
}

export async function readProject(bytes: Uint8Array, bed: { widthMm: number; depthMm: number }): Promise<ImportedProject> {
  return projectOf(await scanProjectFile(bytes), bed)
}

/**
 * Puts a scanned project together for a bed: objects, parts and volumes from the model parts with the settings files,
 * plates laid out by the bed's size. Cheap next to the scan, so a project is laid out again for another bed without
 * reading it again.
 */
export async function projectOf(scanned: ScannedProject, bed: { widthMm: number; depthMm: number }): Promise<ImportedProject> {
  const { files } = scanned
  if (scanned.markError) throw new ProjectReadError(scanned.markError)
  const modelOf = (key: string): ScannedModel => {
    const m = scanned.models.get(key)
    if (!m) throw new ProjectReadError(key === '3D/3dmodel.model' ? 'The 3MF has no model file.' : `The 3MF points at ${key}, which is not in the file.`)
    if ('error' in m) throw new ProjectReadError(m.error)
    return m
  }
  const main = modelOf('3D/3dmodel.model')
  const dec = new TextDecoder()
  // The library stamps sx:Listing and sx:Creator on the root model; they apply to every object without its own.
  const marks = vaultMarksOf(files, scanned.marks)
  const rootSource = sourceOf(marks.root)
  // Bambu Studio and Orca keep each object's mesh in its own file, named by the component's p:path.
  // A component without a path points into the model part it is in.
  const modelAt = (path: string | undefined, from: ScannedModel = main): ScannedModel => (path ? modelOf(path.replace(/^\/+/, '')) : from)

  // Object names, part subtypes and slots from Bambu and Orca's settings file.
  const settingsText = files.get('Metadata/model_settings.config')
  interface PartInfo {
    name?: string
    subtype?: string
    extruder?: number
    raw?: Record<string, string>
  }
  const meta = new Map<string, { name?: string; extruder?: number; parts: Map<string, PartInfo> }>()
  const plateCfg: { name: string; sequence?: 'by-layer' | 'by-object'; nozzleMap?: number[]; objectIds: string[] }[] = []
  if (settingsText) {
    const cfg = xml(dec.decode(settingsText)).documentElement
    const md = (el: Element) => Object.fromEntries(kids(el, 'metadata').map((m) => [m.getAttribute('key') ?? '', m.getAttribute('value') ?? '']))
    for (const o of kids(cfg, 'object')) {
      const m = md(o)
      const id = o.getAttribute('id') ?? ''
      const parts = new Map<string, PartInfo>()
      for (const p of kids(o, 'part')) {
        const pm = md(p)
        const ext = Number(pm['extruder'])
        const raw = Object.fromEntries(Object.entries(pm).filter(([k]) => k !== '' && !PART_META.has(k)))
        parts.set(p.getAttribute('id') ?? '', { ...(pm['name'] ? { name: pm['name'] } : {}), ...(p.getAttribute('subtype') ? { subtype: p.getAttribute('subtype')! } : {}), ...(Number.isInteger(ext) && ext > 0 ? { extruder: ext } : {}), ...(Object.keys(raw).length ? { raw } : {}) })
      }
      const objExt = Number(m['extruder'])
      meta.set(id, { ...(m['name'] ? { name: m['name'] } : {}), ...(Number.isInteger(objExt) && objExt > 0 ? { extruder: objExt } : {}), parts })
    }
    for (const p of kids(cfg, 'plate')) {
      const m = md(p)
      // Bambu Studio's per plate filament map: kept when it was set by hand; an automatic one the slicer picks again.
      const maps = (m['filament_maps'] ?? '').split(/[\s,]+/).map(Number).filter((n) => n === 1 || n === 2)
      const manual = (m['filament_map_mode'] === 'Manual' || m['filament_map_mode'] === 'Nozzle Manual') && maps.length > 0
      plateCfg.push({ name: m['plater_name'] || `Plate ${plateCfg.length + 1}`, ...(m['print_sequence'] === 'by object' ? { sequence: 'by-object' as const } : m['print_sequence'] === 'by layer' ? { sequence: 'by-layer' as const } : {}), ...(manual ? { nozzleMap: maps } : {}), objectIds: kids(p, 'model_instance').map((i) => md(i)['object_id'] ?? '') })
    }
  }

  // PrusaSlicer keeps every volume of an object in one mesh; Slic3r_PE_model.config gives each volume's triangle range,
  // type and settings, and the object's own settings, all in Prusa's keys.
  const prusaText = settingsText ? undefined : files.get('Metadata/Slic3r_PE_model.config')
  const prusa = new Map<string, { name?: string; extruder?: number; settings: Record<string, string>; volumes: PrusaVolume[] }>()
  if (prusaText) {
    const { prusaOverrides } = await import('@slicerx/settings')
    const cfg = xml(dec.decode(prusaText)).documentElement
    const md = (el: Element) => Object.fromEntries(kids(el, 'metadata').map((m) => [m.getAttribute('key') ?? '', m.getAttribute('value') ?? '']))
    const settingsOf = (m: Record<string, string>) => prusaOverrides(Object.fromEntries(Object.entries(m).filter(([k]) => k !== '' && !PRUSA_META.has(k))))
    const slot = (v: string | undefined) => {
      const n = Number(v)
      return Number.isInteger(n) && n > 0 ? n : undefined
    }
    for (const o of kids(cfg, 'object')) {
      const om = md(o)
      const volumes: PrusaVolume[] = kids(o, 'volume').map((v) => {
        const vm = md(v)
        const ext = slot(vm['extruder'])
        return { first: Number(v.getAttribute('firstid')), last: Number(v.getAttribute('lastid')), ...(vm['name'] ? { name: vm['name'] } : {}), type: vm['volume_type'] ?? (vm['modifier'] === '1' ? 'ParameterModifier' : 'ModelPart'), ...(ext ? { extruder: ext } : {}), settings: settingsOf(vm) }
      })
      const ext = slot(om['extruder'])
      prusa.set(o.getAttribute('id') ?? '', { ...(om['name'] ? { name: om['name'] } : {}), ...(ext ? { extruder: ext } : {}), settings: settingsOf(om), volumes })
    }
  }

  const plateOf = (objectId: string): number => Math.max(0, plateCfg.findIndex((p) => p.objectIds.includes(objectId)))
  const plates: ImportedPlate[] = (plateCfg.length ? plateCfg : [{ name: 'Plate 1', objectIds: [] }]).map((p) => ({ name: p.name, ...(p.sequence ? { sequence: p.sequence } : {}), ...(p.nozzleMap ? { nozzleMap: p.nozzleMap } : {}), objects: [] }))
  const ears = parseBrimEars(files.get('Metadata/brim_ear_points.txt'))
  // Orca places objects on the machine; the plate counts from the printable area's front left corner.
  const [ax, ay] = projectOrigin(files.get('Metadata/project_settings.config'))
  // Plates after the first sit to the side of it by the size of the bed the project was laid out on.
  const layoutBed = areaSize(projectArea(files.get('Metadata/project_settings.config'))) ?? bed
  for (const [itemIndex, item] of main.items.entries()) {
    const obj = main.objects.get(item.objectId)
    if (!obj) continue
    const info = meta.get(item.objectId)
    const parts: MeshPart[] = []
    const paintByPart: Record<number, PaintOfPart> = {}
    const volumes: ImportedVolume[] = []
    const rawPartSettings: Record<string, Record<string, string>> = {}
    const pz = prusa.get(item.objectId)
    const sources: { obj: ScannedObject | undefined; id: string; matrix: Mat | null }[] = pz?.volumes.length && obj.mesh
      ? []
      : obj.components.length
        ? meshLeaves(main, obj, modelAt)
        : [{ obj, id: item.objectId, matrix: null }]
    if (pz?.volumes.length && obj.mesh) {
      // The vertices are stored in the object's space already; a volume's matrix only says how to get its own mesh back.
      for (const v of pz.volumes) {
        const name = v.name ?? pz.name ?? obj.name ?? 'Part'
        const part = subMesh(obj.mesh, v.first, v.last, name, v.extruder ?? pz.extruder ?? 1)
        if (!part) throw new ProjectReadError('The 3MF names a volume outside its object\'s mesh.')
        const role = PRUSA_ROLE[v.type]
        if (role) volumes.push({ name, role, part, ...(role === 'modifier' && Object.keys(v.settings).length ? { rawSettings: v.settings } : {}) })
        else if (v.type === 'ModelPart') {
          // The object's settings apply to each of its parts; a part's own settings win.
          const raw = { ...pz.settings, ...v.settings }
          if (Object.keys(raw).length) rawPartSettings[name] = raw
          parts.push(part)
        }
      }
    }
    for (const src of sources) {
      const mesh = src.obj?.mesh
      if (!mesh) continue
      const pi = info?.parts.get(src.id)
      const role = pi?.subtype ? ROLE[pi.subtype] : undefined
      const name = pi?.name ?? src.obj?.name ?? info?.name ?? 'Part'
      if (pi?.subtype && !role && pi.subtype !== 'normal_part') continue // other subtypes are not supported
      const baked = bakeMesh(mesh, src.matrix, name, pi?.extruder ?? info?.extruder ?? 1)
      if (role) volumes.push({ name, role, part: baked, ...(role === 'modifier' && pi?.raw ? { rawSettings: pi.raw } : {}) })
      else {
        if (mesh.paint) paintByPart[parts.length] = mesh.paint
        if (pi?.raw) rawPartSettings[name] = pi.raw
        parts.push(baked)
      }
    }
    if (parts.length === 0) continue
    const pIndex = plateOf(item.objectId)
    const [ox, oy] = plateOffset(pIndex, plates.length, layoutBed)
    const t = item.transform ? [...item.transform] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    t[12] = t[12]! - ox - ax
    t[13] = t[13]! - oy - ay
    const itemEars = ears.get(itemIndex + 1)?.map((e) => [...e] as [number, number, number, number])
    if (sources.some((s) => s.matrix)) centerObject(parts, volumes, t, itemEars)
    const own = marks.objects.get(item.objectId)
    const source = own ? sourceOf({ ...marks.root, ...own }) : rootSource
    ;(plates[pIndex] ?? plates[0]!).objects.push({ name: info?.name ?? pz?.name ?? obj.name ?? parts[0]!.name, parts, volumes, transform: t, ...(Object.keys(rawPartSettings).length ? { rawPartSettings } : {}), ...(Object.keys(paintByPart).length ? { paint: paintByPart } : {}), ...(item.printable ? {} : { printable: false }), ...(itemEars ? { brimPoints: itemEars } : {}), ...(source ? { source } : {}), fileId: item.objectId })
  }
  // Marks from Orca and Bambu Studio's layer slider: color change 0, pause 1, custom 4 (other types are not carried over).
  const marksText = files.get('Metadata/custom_gcode_per_layer.xml')
  if (marksText) {
    try {
      const root = xml(dec.decode(marksText)).documentElement
      for (const pl of kids(root, 'plate')) {
        const id = Number(kids(pl, 'plate_info')[0]?.getAttribute('id'))
        const target = plates[id - 1]
        if (!target) continue
        const marks: NonNullable<ImportedPlate['marks']> = []
        for (const l of kids(pl, 'layer')) {
          const z = Number(l.getAttribute('top_z'))
          const type = Number(l.getAttribute('type'))
          if (!Number.isFinite(z) || z <= 0) continue
          if (type === 0) marks.push({ z, kind: 'color_change' })
          else if (type === 1) marks.push({ z, kind: 'pause' })
          else if (type === 4) marks.push({ z, kind: 'custom', gcode: l.getAttribute('extra') ?? l.getAttribute('gcode') ?? '' })
        }
        if (marks.length) target.marks = marks.slice(0, 200)
      }
    } catch {
      // A damaged marks file leaves the project without marks; the rest still opens.
    }
  }
  if (plates.every((p) => p.objects.length === 0)) throw new ProjectReadError('The 3MF has nothing to print.')
  // Settings by height, by object (Orca and Bambu Studio's height range modifiers).
  const rangesText = files.get('Metadata/layer_config_ranges.xml')
  if (rangesText) {
    try {
      const { importProject } = await import('@slicerx/settings')
      const ranges = importProject({ projectSettings: {}, layerRanges: dec.decode(rangesText) }).layerRanges
      // The file numbers objects from 1 in the order the build first places them, not by their ids.
      const order = [...new Set(main.items.map((i) => i.objectId))]
      for (const pl of plates) {
        for (const o of pl.objects) {
          const index = String(order.indexOf(o.fileId) + 1)
          const own = ranges.filter((r) => r.objectId === index).map((r) => ({ minZ: r.minZ, maxZ: r.maxZ, settings: r.overrides as Record<string, import('@slicerx/contracts').SettingValue> }))
          if (own.length) o.layerRanges = own
        }
      }
    } catch {
      // A damaged ranges file leaves the objects without ranges; the rest still opens.
    }
  }
  let colors: string[] = []
  let settings: Record<string, unknown> = {}
  let settingsFrom: ImportedProject['settingsFrom'] = 'orca'
  const ps = files.get('Metadata/project_settings.config')
  const pe = ps ? undefined : files.get('Metadata/Slic3r_PE.config')
  if (pe) {
    // A PrusaSlicer project: its config, mapped to the Orca keys and value forms an Orca project carries.
    const { prusaProjectSettings } = await import('@slicerx/settings')
    settings = prusaProjectSettings(dec.decode(pe)).values
    settingsFrom = 'prusaslicer'
    if (Array.isArray(settings['filament_colour'])) colors = settings['filament_colour'].filter((c): c is string => typeof c === 'string')
  }
  if (ps) {
    try {
      const j: unknown = JSON.parse(dec.decode(ps))
      if (j !== null && typeof j === 'object' && !Array.isArray(j)) settings = j as Record<string, unknown>
      if (Array.isArray(settings['filament_colour'])) colors = settings['filament_colour'].filter((c): c is string => typeof c === 'string')
    } catch {
      // Settings that do not parse are left out; geometry still opens.
    }
  }
  // A 3MF that is no slicer's project (no project settings: a CAD export, a downloaded model) is placed the way Orca
  // places one (Plater::priv::load_files: center_instances_around_point, then ensure_on_bed): its objects, as one
  // group, centered on the bed, each resting on it. Its own coordinates are the modeler's, not a print bed's.
  if (!ps && !pe) for (const p of plates) placeOnBed(p.objects, bed)
  else for (const p of plates) for (const o of p.objects) settleOnBed(o)
  const dimensions = parseDimensions(files.get('Metadata/slicerx_dimensions.json'), new Set(plates.flatMap((p) => p.objects.map((o) => o.fileId))))
  const fileIds = new Set(plates.flatMap((p) => p.objects.map((o) => o.fileId)))
  const note = historyNewer(files)
  return { plates, colors, settings, settingsFrom, dimensions, histories: parseHistories(files, fileIds), namedValues: parseValues(files), ...(note ? { historyNote: note } : {}) }
}
