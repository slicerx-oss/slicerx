// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads a 3MF project (SlicerX .sx3mf, Bambu Studio or OrcaSlicer) into objects, parts and volumes. The
// part subtypes of Orca's 3MF layout decide what a part is: normal parts print, negative parts cut,
// support blockers and enforcers steer support. The archive is untrusted: entry count, sizes and names
// are capped before anything is inflated.
import type { NamedValue } from '../cad/value-names'
import { parseValues } from './values-file'
import type { MeshPart } from '@slicerx/contracts'
import type { Dimension, DimensionAnchor, Feature } from '../geom/cad'
import type { History } from '../cad/history/model'
import { historyNewer, parseHistories } from './history-read'
import type { VolumeRole } from '../state/store'
import { areaOrigin } from '../plate/bed-origin'

const MAX_ENTRIES = 4000
const MAX_ENTRY = 256 * 1024 * 1024
const MAX_TOTAL = 768 * 1024 * 1024

export class ProjectReadError extends Error {}

/** Caps for an untrusted archive: how many entries, how large one entry and all of them may be once inflated. */
export interface ZipLimits {
  entries: number
  entry: number
  total: number
  /** What the archive should be, for the message when it is not a zip at all. */
  what?: string
}

const PROJECT_LIMITS: ZipLimits = { entries: MAX_ENTRIES, entry: MAX_ENTRY, total: MAX_TOTAL, what: 'a 3MF archive' }

/** Reads the archive's entries. Stored and deflated entries only; anything else is refused. */
export async function unzipEntries(bytes: Uint8Array, limits: ZipLimits = PROJECT_LIMITS): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ProjectReadError(`This is not ${limits.what ?? 'a zip archive'}.`)
  let count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  // ZIP64: the real count and directory offset sit in a record the locator before the end record points to.
  if ((count === 0xffff || at === 0xffffffff) && eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50) {
    const rec = Number(view.getBigUint64(eocd - 20 + 8, true))
    if (rec + 56 > bytes.length || view.getUint32(rec, true) !== 0x06064b50) throw new ProjectReadError('The archive is damaged.')
    count = Number(view.getBigUint64(rec + 32, true))
    at = Number(view.getBigUint64(rec + 48, true))
  }
  if (count > limits.entries) throw new ProjectReadError('The archive has too many files.')
  const dec = new TextDecoder()
  const out = new Map<string, Uint8Array>()
  let total = 0
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new ProjectReadError('The archive is damaged.')
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    let csize = view.getUint32(at + 20, true)
    let usize = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    let local = view.getUint32(at + 42, true)
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen))
    // ZIP64 extra field: the values that did not fit in 32 bits, in this order.
    if (usize === 0xffffffff || csize === 0xffffffff || local === 0xffffffff) {
      let e = at + 46 + nameLen
      const end = e + extraLen
      while (e + 4 <= end) {
        const tag = view.getUint16(e, true)
        const size = view.getUint16(e + 2, true)
        if (tag === 1) {
          let p = e + 4
          if (usize === 0xffffffff) (usize = Number(view.getBigUint64(p, true))), (p += 8)
          if (csize === 0xffffffff) (csize = Number(view.getBigUint64(p, true))), (p += 8)
          if (local === 0xffffffff) local = Number(view.getBigUint64(p, true))
        }
        e += 4 + size
      }
    }
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (flags & 1) throw new ProjectReadError('The archive is encrypted.')
    if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.includes('\0') || name.split(/[\\/]/).includes('..')) throw new ProjectReadError('The archive has a file with an unsafe path.')
    if (usize > limits.entry || (total += usize) > limits.total) throw new ProjectReadError('The archive is too large to open.')
    if (local + 30 > bytes.length) throw new ProjectReadError('The archive is damaged.')
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const raw = bytes.subarray(start, start + csize)
    if (raw.length !== csize) throw new ProjectReadError('The archive is damaged.')
    if (method === 0) out.set(name, raw.length === usize ? raw : raw.subarray(0, Math.min(raw.length, usize)))
    else if (method === 8) out.set(name, await inflate(raw, usize, limits.entry))
    else throw new ProjectReadError('The archive uses a compression this app cannot read.')
  }
  return out
}

async function inflate(raw: Uint8Array, expected: number, cap: number): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(raw), c.close()) })
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    // A lying header cannot make the output bigger than it declared.
    if (size > expected || size > cap) {
      await reader.cancel()
      throw new ProjectReadError('A file in the archive inflates to more than it declares.')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

export interface ImportedVolume {
  name: string
  role: VolumeRole
  /** In the object's coordinates. */
  part: MeshPart
  /** A modifier's settings as the file wrote them (Orca's strings). Untrusted: take them through project-settings.ts. */
  rawSettings?: Record<string, string>
}

/** Painted triangles of one part by layer, as the file's paint texts. */
export type PaintOfPart = Partial<Record<'color' | 'seam' | 'support' | 'fuzzy', Record<number, string>>>

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

type Mat = number[]

function parseTransform(s: string | null): Mat | null {
  if (!s) return null
  const v = s.trim().split(/\s+/).map(Number)
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return null
  return [v[0]!, v[1]!, v[2]!, 0, v[3]!, v[4]!, v[5]!, 0, v[6]!, v[7]!, v[8]!, 0, v[9]!, v[10]!, v[11]!, 1]
}

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

// Model files hold the meshes and can run to tens of megabytes, so they are scanned as text instead of built
// as a DOM: a million vertices as elements would need hundreds of megabytes of memory.

interface ScannedObject {
  name?: string
  mesh: (MeshPart & { paint?: PaintOfPart }) | null
  components: { path?: string; objectId: string; transform: Mat | null }[]
}

interface ScannedModel {
  objects: Map<string, ScannedObject>
  items: { objectId: string; transform: Mat | null; printable: boolean }[]
}

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = m[2]!
  return out
}

const unescapeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

function scanMesh(body: string): (MeshPart & { paint?: PaintOfPart }) | null {
  const vs = body.indexOf('<vertices')
  const ts = body.indexOf('<triangles')
  if (vs < 0 || ts < 0) return null
  const vEnd = body.indexOf('</vertices>', vs)
  const tEnd = body.indexOf('</triangles>', ts)
  const vText = body.slice(vs, vEnd < 0 ? undefined : vEnd)
  const tText = body.slice(ts, tEnd < 0 ? undefined : tEnd)
  const pos: number[] = []
  let fast = /<vertex x="([^"]*)" y="([^"]*)" z="([^"]*)"/g
  for (let m = fast.exec(vText); m; m = fast.exec(vText)) pos.push(Number(m[1]), Number(m[2]), Number(m[3]))
  if (pos.length === 0) {
    for (const m of vText.matchAll(/<vertex\b([^>]*)>/g)) {
      const a = attrsOf(m[1]!)
      pos.push(Number(a['x']), Number(a['y']), Number(a['z']))
    }
  }
  const idx: number[] = []
  const paint: PaintOfPart = {}
  fast = /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g
  for (let m = fast.exec(tText); m; m = fast.exec(tText)) idx.push(Number(m[1]), Number(m[2]), Number(m[3]))
  if (idx.length === 0) {
    for (const m of tText.matchAll(/<triangle\b([^>]*)>/g)) {
      const a = attrsOf(m[1]!)
      idx.push(Number(a['v1']), Number(a['v2']), Number(a['v3']))
    }
  }
  // Painted triangles carry extra attributes, so a second pass runs only when the text has any.
  if (/paint_(color|seam|supports|fuzzy_skin)=/.test(tText)) {
    let tri = 0
    for (const m of tText.matchAll(/<triangle\b([^>]*)>/g)) {
      const a = attrsOf(m[1]!)
      if (a['paint_color']) (paint.color ??= {})[tri] = a['paint_color']
      if (a['paint_seam']) (paint.seam ??= {})[tri] = a['paint_seam']
      if (a['paint_supports']) (paint.support ??= {})[tri] = a['paint_supports']
      if (a['paint_fuzzy_skin']) (paint.fuzzy ??= {})[tri] = a['paint_fuzzy_skin']
      tri++
    }
  }
  const vertexCount = pos.length / 3
  if (pos.some((n) => !Number.isFinite(n))) throw new ProjectReadError('The 3MF model has a vertex that is not a number.')
  for (const n of idx) if (!Number.isInteger(n) || n < 0 || n >= vertexCount) throw new ProjectReadError('The 3MF model has a triangle that points outside its vertices.')
  return { name: '', slot: 1, positions: new Float32Array(pos), indices: new Uint32Array(idx), ...(Object.keys(paint).length ? { paint } : {}) }
}

function scanModel(text: string): ScannedModel {
  const objects = new Map<string, ScannedObject>()
  const objRe = /<object\b([^>]*?)(\/?)>/g
  for (let m = objRe.exec(text); m; m = objRe.exec(text)) {
    const a = attrsOf(m[1]!)
    const id = a['id'] ?? ''
    let body = ''
    if (m[2] !== '/') {
      const end = text.indexOf('</object>', objRe.lastIndex)
      body = text.slice(objRe.lastIndex, end < 0 ? undefined : end)
      objRe.lastIndex = end < 0 ? text.length : end + 9
    }
    const components = [...body.matchAll(/<component\b([^>]*)>/g)].map((c) => {
      const ca = attrsOf(c[1]!)
      return { ...(ca['p:path'] ? { path: ca['p:path'] } : {}), objectId: ca['objectid'] ?? '', transform: parseTransform(ca['transform'] ?? null) }
    })
    objects.set(id, { ...(a['name'] ? { name: unescapeXml(a['name']) } : {}), mesh: body.includes('<mesh') ? scanMesh(body) : null, components })
  }
  const bs = text.indexOf('<build')
  const items = bs < 0 ? [] : [...text.slice(bs).matchAll(/<item\b([^>]*)>/g)].map((i) => {
    const ia = attrsOf(i[1]!)
    return { objectId: ia['objectid'] ?? '', transform: parseTransform(ia['transform'] ?? null), printable: ia['printable'] !== '0' && ia['printable'] !== 'false' }
  })
  return { objects, items }
}

function projectOrigin(config: Uint8Array | undefined): readonly [number, number] {
  if (!config) return [0, 0]
  try {
    const j: unknown = JSON.parse(new TextDecoder().decode(config))
    return j !== null && typeof j === 'object' && !Array.isArray(j) ? areaOrigin((j as Record<string, unknown>)['printable_area']) : [0, 0]
  } catch {
    return [0, 0]
  }
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
export async function readProject(bytes: Uint8Array, bed: { widthMm: number; depthMm: number }): Promise<ImportedProject> {
  const files = await unzipEntries(bytes)
  const modelBytes = files.get('3D/3dmodel.model')
  if (!modelBytes) throw new ProjectReadError('The 3MF has no model file.')
  const dec = new TextDecoder()
  const mainText = dec.decode(modelBytes)
  const main = scanModel(mainText)
  // The library stamps sx:Listing and sx:Creator on the root model; they apply to every object without its own.
  const rootMeta = (name: string) => new RegExp(`<metadata\\s+name="${name}"\\s*>([^<]*)</metadata>`).exec(mainText.slice(0, 1 << 20))?.[1]?.trim() || undefined
  const rootListing = rootMeta('sx:Listing')
  const rootCreator = rootMeta('sx:Creator')
  const rootSource = rootListing || rootCreator ? { ...(rootListing ? { modelId: unescapeXml(rootListing) } : {}), ...(rootCreator ? { creatorId: unescapeXml(rootCreator) } : {}) } : undefined
  // Bambu Studio and Orca keep each object's mesh in its own file, named by the component's p:path.
  const others = new Map<string, ScannedModel>()
  const modelAt = (path: string | undefined): ScannedModel => {
    if (!path) return main
    const key = path.replace(/^\/+/, '')
    let m = others.get(key)
    if (!m) {
      const b = files.get(key)
      if (!b) throw new ProjectReadError(`The 3MF points at ${key}, which is not in the file.`)
      m = scanModel(dec.decode(b))
      others.set(key, m)
    }
    return m
  }

  // Object names, part subtypes and slots from Bambu and Orca's settings file.
  const settingsText = files.get('Metadata/model_settings.config')
  interface PartInfo {
    name?: string
    subtype?: string
    extruder?: number
    raw?: Record<string, string>
  }
  const meta = new Map<string, { name?: string; extruder?: number; parts: Map<string, PartInfo> }>()
  const sxSource = new Map<string, { modelId?: string; creatorId?: string }>()
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
      if (m['sx:Listing'] || m['sx:Creator']) sxSource.set(id, { ...(m['sx:Listing'] ? { modelId: m['sx:Listing'] } : {}), ...(m['sx:Creator'] ? { creatorId: m['sx:Creator'] } : {}) })
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
        ? obj.components.map((c) => ({ obj: modelAt(c.path).objects.get(c.objectId), id: c.objectId, matrix: c.transform }))
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
    const [ox, oy] = plateOffset(pIndex, plates.length, bed)
    const t = item.transform ? [...item.transform] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    t[12] = t[12]! - ox - ax
    t[13] = t[13]! - oy - ay
    const source = sxSource.get(item.objectId) ?? rootSource
    ;(plates[pIndex] ?? plates[0]!).objects.push({ name: info?.name ?? pz?.name ?? obj.name ?? parts[0]!.name, parts, volumes, transform: t, ...(Object.keys(rawPartSettings).length ? { rawPartSettings } : {}), ...(Object.keys(paintByPart).length ? { paint: paintByPart } : {}), ...(item.printable ? {} : { printable: false }), ...(ears.get(itemIndex + 1) ? { brimPoints: ears.get(itemIndex + 1)! } : {}), ...(source ? { source } : {}), fileId: item.objectId })
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
  const dimensions = parseDimensions(files.get('Metadata/slicerx_dimensions.json'), new Set(plates.flatMap((p) => p.objects.map((o) => o.fileId))))
  const fileIds = new Set(plates.flatMap((p) => p.objects.map((o) => o.fileId)))
  const note = historyNewer(files)
  return { plates, colors, settings, settingsFrom, dimensions, histories: parseHistories(files, fileIds), namedValues: parseValues(files), ...(note ? { historyNote: note } : {}) }
}
