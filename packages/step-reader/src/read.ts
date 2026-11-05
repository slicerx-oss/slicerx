// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP and IGES to mesh, without any worker plumbing (so tests run it directly). OpenCASCADE (occt-import-js, built by
// ../build.sh) reads the file, converts its length unit to millimeters and meshes every solid. This module picks what
// to keep, names it and groups it into objects.
//
// - Solids are kept. Open shells and loose faces are construction or reference geometry in most CAD exports and are
//   left out when the file has solids; a file with shells only keeps them (a mesh repair closes them). A STEP file
//   with loose faces only is refused. An IGES file with loose faces only keeps them, joined into a body per group of
//   touching faces: many CAD programs write IGES as trimmed surfaces with no solid at all.
// - Bodies whose boxes touch or overlap stay together as one object with a part per body, in place (a bolt in its
//   bracket). Bodies apart from the rest become objects of their own.
// - Chord tolerance 0.01 mm and 0.5 rad, measured on the NIST test models and our own parts: under a second for most
//   parts, 5 s for the largest. 0.003 mm triples the triangles for no difference a printer can show. Past the
//   triangle limit the file is meshed again at 0.05 mm.
// - A body keeps the color the file gives its solid, as data (`color`). Faces with colors of their own are not read.

export interface OcctMesh {
  name?: string
  /** solid, shell or faces (added by our patch, patches/0001-mesh-kind.patch). */
  kind?: string
  /** The shape's color, 0 to 1 per channel, when the file gives one. */
  color?: ArrayLike<number>
  attributes: { position: { array: ArrayLike<number> } }
  index: { array: ArrayLike<number> }
}

/** A node of the file's tree: its name and the meshes it holds (indices into `meshes`). */
export interface OcctNode {
  name?: string
  meshes?: number[]
  children?: OcctNode[]
}

export interface OcctResult {
  success: boolean
  meshes: OcctMesh[]
  root?: OcctNode
}

export interface OcctParams {
  linearUnit: 'millimeter'
  linearDeflectionType: 'absolute_value'
  linearDeflection: number
  angularDeflection: number
}

/** The loaded OpenCASCADE module, as far as this package calls it. */
export interface Occt {
  ReadStepFile(data: Uint8Array, params: OcctParams | null): OcctResult
  ReadIgesFile(data: Uint8Array, params: OcctParams | null): OcctResult
}

/** The CAD formats this package reads. */
export type CadFormat = 'step' | 'iges'

export type StepQuality = 'normal' | 'coarser' | 'finer'

/** Chord tolerance in mm for each quality. */
export const STEP_TOLERANCE: Record<StepQuality, number> = { finer: 0.003, normal: 0.01, coarser: 0.05 }
export const STEP_ANGLE_RAD = 0.5
export const STEP_MAX_MB = 100
export const STEP_MAX_TRIANGLES = 2_000_000

/** Why a STEP or IGES file could not be read. Stable: an app or an MCP client can branch on these. */
export const STEP_ERROR_CODES = ['empty', 'not_step', 'step_xml', 'not_iges', 'iges_compressed', 'too_large', 'no_solids', 'too_detailed', 'unreadable', 'out_of_memory', 'timeout'] as const
export type StepErrorCode = (typeof STEP_ERROR_CODES)[number]

/** A STEP or IGES file that cannot be added, with the reason in plain words meant to follow the file name, and its code. */
export class StepError extends Error {
  override readonly name = 'StepError'
  readonly code: StepErrorCode
  constructor(code: StepErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export type StepUnit = 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot'

export interface StepBody {
  name: string
  positions: Float64Array
  indices: Uint32Array
  /** The body's color as #rrggbb, when the file gives its solid one. */
  color?: string
}

/** What a STEP or IGES file holds, in millimeters. */
export interface StepRead {
  /** Objects to add, each with its parts (one per body). */
  objects: { name: string; bodies: StepBody[] }[]
  /** The length unit the file declares; positions are already millimeters. */
  unit: StepUnit | null
  triangles: number
  toleranceMm: number
  /** Short sentences for an import message. */
  notes: string[]
}

export interface ReadOptions {
  /** The app's name, for refusals such as "uses STEP entities <name> does not support". Default "this reader". */
  appName?: string
}

const latin1 = new TextDecoder('latin1')

/** The file's length unit, from its header entities. */
export function stepUnit(bytes: Uint8Array): StepUnit | null {
  const text = latin1.decode(bytes)
  const conv = /CONVERSION_BASED_UNIT\s*\(\s*'\s*(INCH|IN|FOOT|FT)\s*'/i.exec(text)
  if (conv) return /^(INCH|IN)$/i.test(conv[1]!) ? 'inch' : 'foot'
  const si = /SI_UNIT\s*\(\s*(\$|\.\w+\.)\s*,\s*\.METRE\.\s*\)/i.exec(text)
  if (!si) return null
  const p = si[1]!.toUpperCase()
  return p === '.MILLI.' ? 'millimeter' : p === '.CENTI.' ? 'centimeter' : p === '$' ? 'meter' : null
}

/** The units an IGES file names in its global section (unit flag, parameter 14), as far as StepUnit has them. */
const IGES_UNIT_FLAGS: Record<number, StepUnit> = { 1: 'inch', 2: 'millimeter', 4: 'foot', 6: 'meter', 10: 'centimeter' }
const IGES_UNIT_NAMES: Record<string, StepUnit> = { IN: 'inch', INCH: 'inch', MM: 'millimeter', FT: 'foot', M: 'meter', CM: 'centimeter' }

/** An IGES file's 80 column records, with or without line breaks between them. */
function igesRecords(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 || lines[0]!.length <= 80) return lines
  return lines[0]!.match(/.{1,80}/gs) ?? []
}

/** What the first record says about an IGES file: 'iges' for the fixed ASCII form, 'compressed', or null for neither. */
function igesKind(bytes: Uint8Array): 'iges' | 'compressed' | null {
  const first = igesRecords(latin1.decode(bytes.subarray(0, 4096)))[0] ?? ''
  if (first.length < 73) return null
  const section = first[72]
  // The start section comes first; some writers leave it out and begin with the global section.
  if ((section === 'S' || section === 'G') && /^\s*\d{7}\s*$/.test(first.slice(73, 80))) return 'iges'
  if (section === 'C') return 'compressed'
  return null
}

/** The parameters of an IGES global section, as text, with Hollerith strings (4HINCH) unwrapped. */
function igesGlobals(bytes: Uint8Array): string[] {
  const g = igesRecords(latin1.decode(bytes))
    .filter((r) => r[72] === 'G')
    .map((r) => r.slice(0, 72))
    .join('')
  // The first two parameters name the parameter and record delimiters; empty means , and ;.
  let at = 0
  const out: string[] = []
  let delim = ','
  let end = ';'
  while (at < g.length) {
    const holl = /^\s*(\d+)H/.exec(g.slice(at))
    let value: string
    if (holl) {
      const start = at + holl[0].length
      value = g.slice(start, start + Number(holl[1]))
      at = start + value.length
      while (at < g.length && g[at] === ' ') at++
    } else {
      let stop = at
      while (stop < g.length && g[stop] !== delim && g[stop] !== end) stop++
      value = g.slice(at, stop).trim()
      at = stop
    }
    out.push(value)
    if (out.length === 1 && value.length === 1) delim = value
    if (out.length === 2 && value.length === 1) end = value
    if (at >= g.length || (g[at] === end && out.length > 2)) break
    // A file that names its own delimiters may still follow the first two with the default comma.
    if (g[at] === delim || g[at] === end || (out.length <= 2 && g[at] === ',')) at++
    else break
  }
  return out
}

/** The length unit an IGES file declares in its global section, or null when it names none StepUnit has. */
export function igesUnit(bytes: Uint8Array): StepUnit | null {
  const globals = igesGlobals(withoutBom(bytes))
  const flag = Number(globals[13])
  if (flag === 3) return IGES_UNIT_NAMES[(globals[14] ?? '').trim().toUpperCase()] ?? null
  return IGES_UNIT_FLAGS[flag] ?? null
}

/** The format of a file: what its bytes say, else what its name says, else null. */
export function cadFormat(file: Uint8Array, fileName = ''): CadFormat | null {
  const bytes = withoutBom(file)
  const head = latin1.decode(bytes.subarray(0, 4096)).trimStart()
  if (head.startsWith('ISO-10303-21')) return 'step'
  if (igesKind(bytes)) return 'iges'
  if (/\.(igs|iges)$/i.test(fileName)) return 'iges'
  if (/\.(step|stp)$/i.test(fileName)) return 'step'
  return null
}

/**
 * The bytes after a UTF-8 byte order mark (EF BB BF), which some editors and Windows tools write in front of the
 * ISO-10303-21 line. OpenCASCADE refuses a file that starts with one, so it comes off before anything reads the file.
 */
function withoutBom(bytes: Uint8Array): Uint8Array {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
}

/** Why the bytes are not an IGES file we read, or null when they are one. */
function notIges(bytes: Uint8Array): StepError | null {
  const kind = igesKind(bytes)
  if (kind === 'iges') return null
  if (kind === 'compressed') return new StepError('iges_compressed', 'is a compressed IGES file. Save it from your CAD program as a regular IGES file and open that.')
  return new StepError('not_iges', 'is not an IGES file. An IGES file is made of 80 column records, the first marked S in column 73.')
}

/** Why the bytes are not a STEP file we read, or null when they are one. */
function notStep(bytes: Uint8Array): StepError | null {
  const head = latin1.decode(bytes.subarray(0, 4096)).trimStart()
  if (head.startsWith('ISO-10303-21')) return null
  if (/ISO-10303-28|<\?xml/i.test(head)) return new StepError('step_xml', 'is a STEP XML file. Save it from your CAD program as a regular STEP file (AP203, AP214 or AP242) and open that.')
  return new StepError('not_step', 'is not a STEP file. A STEP file starts with ISO-10303-21.')
}

const GENERIC = /^(solid|shell|body|part|face|surface|open\s?cascade.*|compound|unnamed)?[\s_-]*\d*$/i

function cleanName(s: string | undefined): string {
  return (s ?? '').replace(/[\r\n\t]+/g, ' ').trim()
}

/** Groups bodies whose boxes touch or overlap (within `gap` mm), keeping the file order. */
function groupByBox(boxes: number[][], gap: number): number[][] {
  const parent = boxes.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!
      const b = boxes[j]!
      if (a[0]! <= b[3]! + gap && b[0]! <= a[3]! + gap && a[1]! <= b[4]! + gap && b[1]! <= a[4]! + gap && a[2]! <= b[5]! + gap && b[2]! <= a[5]! + gap) {
        parent[find(j)] = find(i)
      }
    }
  }
  const groups = new Map<number, number[]>()
  boxes.forEach((_, i) => {
    const r = find(i)
    groups.set(r, [...(groups.get(r) ?? []), i])
  })
  return [...groups.values()]
}

/** [minX, minY, minZ, maxX, maxY, maxZ] of a position array. */
export function boxOf(p: ArrayLike<number>): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]!
      if (v < b[k]!) b[k] = v
      if (v > b[k + 3]!) b[k + 3] = v
    }
  }
  return b
}

/** How each format reads, and the words its refusals use. */
interface Format {
  word: 'STEP' | 'IGES'
  read(occt: Occt, bytes: Uint8Array, params: OcctParams): OcctResult
  /** Whether the file has any entity that could be a solid or a surface. */
  shapes(bytes: Uint8Array): boolean
  unit(bytes: Uint8Array): StepUnit | null
  /** Keep loose faces when the file has nothing else. */
  keepFaces: boolean
  /** Give an unnamed mesh the name of the tree node that holds it. */
  nodeNames: boolean
  ext: RegExp
}

const STEP_SHAPES = /\b(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP|SHELL_BASED_SURFACE_MODEL|CLOSED_SHELL|OPEN_SHELL|ADVANCED_FACE|FACE_SURFACE)\s*\(/i

/**
 * IGES entity types that are surfaces or solids, or hold them: plane, surfaces of revolution and extrusion, ruled,
 * spline, offset and trimmed surfaces, CSG primitives and trees, solid instances and assemblies, and the B-rep entities.
 */
const IGES_SHAPES = new Set([108, 114, 118, 120, 122, 128, 140, 143, 144, 150, 152, 154, 156, 158, 160, 162, 164, 168, 180, 184, 186, 190, 192, 194, 196, 198, 430, 502, 504, 508, 510, 514])

/** Whether an IGES file's directory entries name any surface or solid. */
function igesShapes(bytes: Uint8Array): boolean {
  let first = true
  for (const r of igesRecords(latin1.decode(bytes))) {
    if (r[72] !== 'D') continue
    // Each entry is two records; the first starts with the entity type.
    if (first && IGES_SHAPES.has(Number(r.slice(0, 8)))) return true
    first = !first
  }
  return false
}

const STEP: Format = {
  word: 'STEP',
  read: (occt, bytes, params) => occt.ReadStepFile(bytes, params),
  shapes: (bytes) => STEP_SHAPES.test(latin1.decode(bytes)),
  unit: stepUnit,
  keepFaces: false,
  nodeNames: false,
  ext: /\.(step|stp)$/i,
}

const IGES: Format = {
  word: 'IGES',
  read: (occt, bytes, params) => occt.ReadIgesFile(bytes, params),
  shapes: igesShapes,
  unit: igesUnit,
  keepFaces: true,
  nodeNames: true,
  ext: /\.(igs|iges)$/i,
}

const NOTHING = (app: string, word: string): StepError =>
  new StepError('no_solids', `has no solids or surfaces ${app} can read. It may hold only drawings or annotations, or use ${word} entities ${app} does not support.`)

/** Thrown by a capped module when the file needs more memory than the cap (see load.ts). */
export const OUT_OF_MEMORY = 'step-reader: memory cap reached'

function mesh(occt: Occt, f: Format, bytes: Uint8Array, tol: number, app: string): OcctResult {
  let r: OcctResult
  // A capped module (load.ts) refuses to grow past its cap. OpenCASCADE may catch the failed allocation and answer
  // with part of the file or nothing, so a refused growth fails the read whatever came back.
  const outOfMemory = () => (occt as { outOfMemory?: boolean }).outOfMemory === true
  const tooBig = () => new StepError('out_of_memory', 'could not be read: it needs more memory than the reader may use.')
  try {
    r = f.read(occt, bytes, { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: tol, angularDeflection: STEP_ANGLE_RAD })
  } catch {
    if (outOfMemory()) throw tooBig()
    throw new StepError('unreadable', `could not be read: it ran out of memory or uses ${f.word} entities ${app} does not support.`)
  }
  if (outOfMemory()) throw tooBig()
  if (!r.success) {
    if (!f.shapes(bytes)) throw NOTHING(app, f.word)
    throw new StepError('unreadable', `could not be read. It may be damaged, or it uses ${f.word} entities ${app} does not support.`)
  }
  return r
}

const triangles = (ms: OcctMesh[]) => ms.reduce((n, m) => n + Math.floor(m.index.array.length / 3), 0)

/**
 * One channel as two hex digits. OpenCASCADE keeps colors in linear RGB and converts a file's COLOUR_RGB, which is
 * sRGB, on reading; this turns it back into the sRGB value the file holds (0.25 in the file comes out as 0.0508).
 */
function hex2(linear: number): string {
  const c = Math.min(1, Math.max(0, linear))
  const srgb = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
  return Math.round(srgb * 255).toString(16).padStart(2, '0')
}

/** A mesh's color as #rrggbb, or undefined when it has none. */
function colorOf(m: OcctMesh): string | undefined {
  const c = m.color
  if (!c || c.length < 3 || ![c[0], c[1], c[2]].every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined
  return `#${hex2(c[0]!)}${hex2(c[1]!)}${hex2(c[2]!)}`
}

/** The name of each mesh's node, for meshes that are the only one their node holds. */
function nodeNames(root: OcctNode | undefined): Map<number, string> {
  const names = new Map<number, string>()
  const walk = (n: OcctNode) => {
    const name = cleanName(n.name)
    if (name && n.meshes?.length === 1) names.set(n.meshes[0]!, name)
    n.children?.forEach(walk)
  }
  if (root) walk(root)
  return names
}

/** Loose face meshes as one mesh per group of touching ones, in file order. */
function joinFaces(faces: OcctMesh[]): OcctMesh[] {
  const groups = groupByBox(faces.map((m) => boxOf(m.attributes.position.array)), 0.01)
  return groups.map((g) => {
    const parts = g.map((i) => faces[i]!)
    const positions: number[] = []
    const indices: number[] = []
    for (const m of parts) {
      const base = positions.length / 3
      for (const v of Array.from(m.attributes.position.array)) positions.push(v)
      for (const t of Array.from(m.index.array)) indices.push(t + base)
    }
    const names = new Set(parts.map((m) => cleanName(m.name)))
    const colors = new Set(parts.map((m) => colorOf(m) ?? ''))
    const color = colors.size === 1 ? parts[0]!.color : undefined
    return {
      ...(names.size === 1 ? { name: parts[0]!.name } : {}),
      kind: 'faces',
      ...(color ? { color } : {}),
      attributes: { position: { array: positions } },
      index: { array: indices },
    }
  })
}

function read(f: Format, occt: Occt, file: Uint8Array, fileName: string, quality: StepQuality, opts: ReadOptions): StepRead {
  const app = opts.appName ?? 'this reader'
  const bytes = withoutBom(file)
  if (bytes.length === 0) throw new StepError('empty', 'is empty.')
  if (bytes.length > STEP_MAX_MB * 1024 * 1024) throw new StepError('too_large', `is ${Math.round(bytes.length / 1024 / 1024)} MB. ${f.word} files up to ${STEP_MAX_MB} MB can be opened.`)
  const why = f === IGES ? notIges(bytes) : notStep(bytes)
  if (why) throw why
  const notes: string[] = []
  let tol = STEP_TOLERANCE[quality]
  let r = mesh(occt, f, bytes, tol, app)
  const used = (res: OcctResult) => {
    const named = f.nodeNames ? nodeNames(res.root) : new Map<number, string>()
    const meshes = res.meshes.map((m, i) => (cleanName(m.name) || !named.has(i) ? m : { ...m, name: named.get(i)! }))
    const all = meshes.filter((m) => m.index.array.length >= 3)
    const solids = all.filter((m) => m.kind === 'solid')
    const shells = all.filter((m) => m.kind === 'shell' || m.kind === undefined || m.kind === '')
    const faces = all.filter((m) => m.kind === 'faces')
    const joined = !solids.length && !shells.length && f.keepFaces ? joinFaces(faces) : []
    return { all, solids, shells, faces, joined, keep: solids.length ? solids : shells.length ? shells : joined }
  }
  let u = used(r)
  if (u.all.length === 0) throw NOTHING(app, f.word)
  if (u.keep.length === 0) throw new StepError('no_solids', 'has only loose surfaces and no solid bodies, so there is nothing to print. Export it from your CAD program as a solid.')
  if (triangles(u.keep) > STEP_MAX_TRIANGLES && tol < STEP_TOLERANCE.coarser) {
    tol = STEP_TOLERANCE.coarser
    r = mesh(occt, f, bytes, tol, app)
    u = used(r)
    notes.push(`Meshed at ${tol} mm because the model is very detailed.`)
  }
  const total = triangles(u.keep)
  if (total > STEP_MAX_TRIANGLES) throw new StepError('too_detailed', `is too detailed: ${total.toLocaleString('en-US')} triangles at ${tol} mm, more than the ${STEP_MAX_TRIANGLES.toLocaleString('en-US')} ${app} can add at once.`)
  if (u.joined.length) {
    const n = u.joined.length
    notes.push(`The file has surfaces and no solids, so they were joined into ${n === 1 ? 'one body' : `${n} bodies`}.`)
  } else {
    const left = u.all.length - u.keep.length
    if (left > 0) notes.push(`Left out ${left} open ${left === 1 ? 'surface' : 'surfaces'} that ${left === 1 ? 'is' : 'are'} not part of a solid.`)
  }

  const base = fileName.replace(f.ext, '')
  const bodies: StepBody[] = u.keep.map((m, i) => {
    const name = cleanName(m.name)
    const color = colorOf(m)
    return {
      name: name && !GENERIC.test(name) ? name : u.keep.length === 1 ? base : `${base} ${i + 1}`,
      positions: Float64Array.from(m.attributes.position.array),
      indices: Uint32Array.from(m.index.array),
      ...(color ? { color } : {}),
    }
  })
  toLocalOrigin(bodies)
  const groups = groupByBox(bodies.map((b) => boxOf(b.positions)), 0.01)
  const objects = groups.map((g) => ({ name: g.length === 1 ? bodies[g[0]!]!.name : base, bodies: g.map((i) => bodies[i]!) }))
  if (groups.length === 1 && bodies.length > 1) objects[0]!.name = base
  // One object of one body keeps the file's name, like other formats.
  if (objects.length === 1 && bodies.length === 1) objects[0]!.name = base
  const unit = f.unit(bytes)
  if (unit && unit !== 'millimeter') notes.unshift(`Converted from ${unit === 'inch' ? 'inches' : unit === 'foot' ? 'feet' : `${unit}s`} to millimeters.`)
  return { objects, unit, triangles: total, toleranceMm: tol, notes }
}

/** Reads a STEP file into objects and bodies in millimeters. Throws StepError with a plain reason and a code. */
export function readStep(occt: Occt, file: Uint8Array, fileName: string, quality: StepQuality = 'normal', opts: ReadOptions = {}): StepRead {
  return read(STEP, occt, file, fileName, quality, opts)
}

/**
 * Reads an IGES file into objects and bodies in millimeters, in the shape readStep gives. A file of loose surfaces and
 * no solids becomes a body per group of touching surfaces. Throws StepError with a plain reason and a code.
 */
export function readIges(occt: Occt, file: Uint8Array, fileName: string, quality: StepQuality = 'normal', opts: ReadOptions = {}): StepRead {
  return read(IGES, occt, file, fileName, quality, opts)
}

/** Reads a STEP or an IGES file, told apart by its bytes, else its name (cadFormat); anything else reads as STEP. */
export function readCad(occt: Occt, file: Uint8Array, fileName: string, quality: StepQuality = 'normal', opts: ReadOptions = {}): StepRead {
  return cadFormat(file, fileName) === 'iges' ? readIges(occt, file, fileName, quality, opts) : readStep(occt, file, fileName, quality, opts)
}

/**
 * Moves every body by the same amount so their shared box is centered on the origin, in double precision. The meshes
 * go on as 32-bit floats, which far from the origin lose detail (half a millimeter steps at 8 km): a model exported in
 * a site's or an assembly's world coordinates keeps its small features. The bodies keep their places relative to one
 * another; where the model lands on the plate is set later, as for any file.
 */
export function toLocalOrigin(bodies: StepBody[]): void {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const b of bodies) {
    const p = b.positions
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p[i + k]!
        if (v < lo[k]!) lo[k] = v
        if (v > hi[k]!) hi[k] = v
      }
    }
  }
  if (!Number.isFinite(lo[0]!)) return
  const c = [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2)
  for (const b of bodies) {
    const p = b.positions
    for (let i = 0; i + 2 < p.length; i += 3) for (let k = 0; k < 3; k++) p[i + k] = p[i + k]! - c[k]!
  }
}
