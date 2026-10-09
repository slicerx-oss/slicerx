// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scans a 3MF model part (3D/3dmodel.model or a Bambu Studio and Orca 3D/Objects/*.model) from its bytes: objects,
// their meshes as typed arrays, components and build items, every length in millimeters whatever the part's unit. Model parts run to hundreds of megabytes, so nothing
// here makes a string of the whole part or a JS array per coordinate: tags are read in place and numbers parsed
// from the bytes straight into growing typed arrays. What is left once the vertex and triangle runs are cut out
// (the skeleton, a few kilobytes) is decoded for the Vault marks, which need a real tag reader.
import type { MeshPart } from '@slicerx/contracts'

/** 4x4 column-major. */
export type Mat = number[]

/** Painted triangles of one part by layer, as the file's paint texts. */
export type PaintOfPart = Partial<Record<'color' | 'seam' | 'support' | 'fuzzy', Record<number, string>>>

export interface ScannedObject {
  name?: string
  mesh: (MeshPart & { paint?: PaintOfPart }) | null
  components: { path?: string; objectId: string; transform: Mat | null }[]
}

export interface ScannedModel {
  objects: Map<string, ScannedObject>
  items: { objectId: string; transform: Mat | null; printable: boolean }[]
}

/** A model part that is not a usable mesh: a vertex that is not a number, a triangle off its vertices. */
export class ModelScanError extends Error {}

export function parseTransform(s: string | null | undefined): Mat | null {
  if (!s) return null
  const v = s.trim().split(/\s+/).map(Number)
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return null
  return [v[0]!, v[1]!, v[2]!, 0, v[3]!, v[4]!, v[5]!, 0, v[6]!, v[7]!, v[8]!, 0, v[9]!, v[10]!, v[11]!, 1]
}

export const unescapeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

const LT = 60
const GT = 62
const SLASH = 47
const EQ = 61
const DQ = 34
const SQ = 39
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13
const isNameEnd = (c: number) => isSpace(c) || c === GT || c === SLASH

/** Exact powers of ten (up to 1e22 a double holds them exactly). */
const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i)

function latin1(b: Uint8Array, s: number, e: number): string {
  let out = ''
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]!)
  return out
}

/**
 * The number in b[s, e), the same double `Number(text)` gives. Plain decimals with at most 15 significant digits
 * (what slicers write) are one exact integer over an exact power of ten, which IEEE division rounds correctly;
 * anything else goes through Number().
 */
export function parseNumber(b: Uint8Array, s: number, e: number): number {
  let i = s
  let neg = false
  const c0 = b[i]
  if (c0 === 45 || c0 === 43) {
    neg = c0 === 45
    i++
  }
  let mant = 0
  let digits = 0
  let frac = 0
  let any = false
  let dot = false
  for (; i < e; i++) {
    const c = b[i]!
    if (c >= 48 && c <= 57) {
      any = true
      if (mant === 0 && c === 48) {
        if (dot) frac++
        continue
      }
      mant = mant * 10 + (c - 48)
      digits++
      if (dot) frac++
    } else if (c === 46 && !dot) dot = true
    else break
  }
  if (i !== e || !any || digits > 15 || frac > 22) return Number(latin1(b, s, e))
  const v = frac ? mant / POW10[frac]! : mant
  return neg ? -v : v
}

/** A non-negative decimal integer in b[s, e), or -1 when it is not one. */
function parseIndex(b: Uint8Array, s: number, e: number): number {
  if (s >= e || e - s > 15) return e - s > 15 ? Number(latin1(b, s, e)) : -1
  let v = 0
  for (let i = s; i < e; i++) {
    const c = b[i]!
    if (c < 48 || c > 57) {
      const n = Number(latin1(b, s, e))
      return Number.isInteger(n) ? n : -1
    }
    v = v * 10 + (c - 48)
  }
  return v
}

class Floats {
  a = new Float32Array(1 << 12)
  n = 0
  push3(x: number, y: number, z: number): void {
    if (this.n + 3 > this.a.length) {
      const g = new Float32Array(this.a.length * 2)
      g.set(this.a)
      this.a = g
    }
    this.a[this.n++] = x
    this.a[this.n++] = y
    this.a[this.n++] = z
  }
  done(): Float32Array {
    return this.a.slice(0, this.n)
  }
}

class Uints {
  a = new Uint32Array(1 << 12)
  n = 0
  push3(x: number, y: number, z: number): void {
    if (this.n + 3 > this.a.length) {
      const g = new Uint32Array(this.a.length * 2)
      g.set(this.a)
      this.a = g
    }
    this.a[this.n++] = x
    this.a[this.n++] = y
    this.a[this.n++] = z
  }
  done(): Uint32Array {
    return this.a.slice(0, this.n)
  }
}

const dec = new TextDecoder()

/** Attributes of the tag whose name ends at `p`, up to its `>`: [name, value start, value end] triples. */
function readAttrs(b: Uint8Array, p: number, out: number[]): number {
  out.length = 0
  const n = b.length
  for (;;) {
    while (p < n && isSpace(b[p]!)) p++
    if (p >= n) return n
    const c = b[p]!
    if (c === GT) return p + 1
    if (c === SLASH) {
      p++
      continue
    }
    const ns = p
    while (p < n && b[p] !== EQ && !isNameEnd(b[p]!)) p++
    const ne = p
    while (p < n && isSpace(b[p]!)) p++
    if (b[p] !== EQ) continue
    p++
    while (p < n && isSpace(b[p]!)) p++
    const q = b[p]
    if (q !== DQ && q !== SQ) continue
    const vs = ++p
    while (p < n && b[p] !== q) p++
    out.push(ns, ne, vs, p)
    p++
  }
}

function attrIs(b: Uint8Array, s: number, e: number, name: string): boolean {
  if (e - s !== name.length) return false
  for (let i = 0; i < name.length; i++) if (b[s + i] !== name.charCodeAt(i)) return false
  return true
}

function attrMap(b: Uint8Array, at: number[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < at.length; i += 4) out[dec.decode(b.subarray(at[i]!, at[i + 1]!))] = dec.decode(b.subarray(at[i + 2]!, at[i + 3]!))
  return out
}

/**
 * ` x="…" y="…" z="…"/>` (or `>`) right after a vertex's name, the way every slicer writes it: pushes the vertex and
 * returns the position after the tag, or 0 for anything else (the general reader takes it then).
 */
function quickVertex(b: Uint8Array, q: number, pos: Floats, mm: number): number {
  let x = 0
  let y = 0
  let z = 0
  for (let k = 0; k < 3; k++) {
    if (b[q] !== 32 || b[q + 1] !== 120 + k || b[q + 2] !== EQ || b[q + 3] !== DQ) return 0
    const s = q + 4
    const e = b.indexOf(DQ, s)
    if (e < 0) return 0
    const v = parseNumber(b, s, e)
    if (!Number.isFinite(v)) return 0
    if (k === 0) x = v
    else if (k === 1) y = v
    else z = v
    q = e + 1
  }
  const end = tagEnd(b, q)
  if (end === 0) return 0
  pos.push3(x * mm, y * mm, z * mm)
  return end
}

/** ` v1="…" v2="…" v3="…"/>` after a triangle's name, nothing else on it (no paint): as quickVertex. */
function quickTriangle(b: Uint8Array, q: number, idx: Uints): number {
  let v1 = 0
  let v2 = 0
  let v3 = 0
  for (let k = 0; k < 3; k++) {
    if (b[q] !== 32 || b[q + 1] !== 118 || b[q + 2] !== 49 + k || b[q + 3] !== EQ || b[q + 4] !== DQ) return 0
    let v = 0
    let i = q + 5
    const s = i
    for (let c = b[i]!; c >= 48 && c <= 57; c = b[++i]!) v = v * 10 + (c - 48)
    if (i === s || i - s > 15 || b[i] !== DQ) return 0
    if (k === 0) v1 = v
    else if (k === 1) v2 = v
    else v3 = v
    q = i + 1
  }
  const end = tagEnd(b, q)
  if (end === 0) return 0
  idx.push3(v1, v2, v3)
  return end
}

/** The position after `/>` or `>` at q (spaces before it allowed), or 0 when something else follows. */
function tagEnd(b: Uint8Array, q: number): number {
  while (isSpace(b[q]!)) q++
  if (b[q] === SLASH && b[q + 1] === GT) return q + 2
  if (b[q] === GT) return q + 1
  return 0
}

/** Millimeters per 3MF unit (3MF core specification, the model element's unit attribute; millimeter by default). */
const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }

/** A transform read in the part's unit, its translation in millimeters (rotation and scale have no unit). */
function inMm(m: Mat | null, mm: number): Mat | null {
  if (!m || mm === 1) return m
  m[12] = m[12]! * mm
  m[13] = m[13]! * mm
  m[14] = m[14]! * mm
  return m
}

const PAINT: Record<string, keyof PaintOfPart> = { paint_color: 'color', paint_seam: 'seam', paint_supports: 'support', paint_fuzzy_skin: 'fuzzy' }

/**
 * Scans a model part. `skeleton` receives the part's bytes without its vertex and triangle runs, for readers that
 * want the rest of the XML (the Vault marks).
 */
export function scanModelBytes(b: Uint8Array, skeleton?: (bytes: Uint8Array) => void): ScannedModel {
  const objects = new Map<string, ScannedObject>()
  const items: ScannedModel['items'] = []
  const n = b.length
  const at: number[] = []
  const keep: [number, number][] = []
  let keptFrom = 0
  let obj: { id: string; name?: string; components: ScannedObject['components']; mesh: ScannedObject['mesh']; hasMesh: boolean } | null = null
  let pos: Floats | null = null
  let idx: Uints | null = null
  let paint: PaintOfPart = {}
  let tri = 0
  let sawVertices = false
  let sawTriangles = false
  let inBuild = false
  // Millimeters per unit of the part (its model element's unit attribute).
  let mm = 1
  // Where the current run of vertex or triangle tags started, to cut it out of the skeleton.
  let runStart = -1
  const endRun = (at: number) => {
    if (runStart < 0) return
    keep.push([keptFrom, runStart])
    keptFrom = at
    runStart = -1
  }
  const finishMesh = () => {
    if (!pos || !idx || !obj) return
    const positions = pos.done()
    const indices = idx.done()
    pos = null
    idx = null
    // A mesh without its vertices or its triangles element is no mesh.
    if (!sawVertices || !sawTriangles) return
    const vertexCount = positions.length / 3
    for (let i = 0; i < indices.length; i++) if (indices[i]! >= vertexCount) throw new ModelScanError('The 3MF model has a triangle that points outside its vertices.')
    obj.mesh = { name: '', slot: 1, positions, indices, ...(Object.keys(paint).length ? { paint } : {}) }
  }
  let p = 0
  while (p < n) {
    const lt = b.indexOf(LT, p)
    if (lt < 0) break
    let q = lt + 1
    const c1 = b[q]
    if (c1 === 63 || c1 === 33) {
      // <? ... ?>, <!-- -->, <![CDATA[ ]]> and <!DOCTYPE>: kept for the skeleton's reader, skipped here.
      endRun(lt)
      const comment = c1 === 33 && b[q + 1] === 45 && b[q + 2] === 45
      if (comment) {
        let e = q + 3
        while (e < n && !(b[e] === 45 && b[e + 1] === 45 && b[e + 2] === GT)) e++
        p = e + 3
      } else {
        const e = b.indexOf(GT, q)
        p = e < 0 ? n : e + 1
      }
      continue
    }
    const closing = c1 === SLASH
    if (closing) q++
    const ns = q
    while (q < n && !isNameEnd(b[q]!)) q++
    // The local name, without a namespace prefix.
    let ls = ns
    for (let i = ns; i < q; i++) if (b[i] === 58) ls = i + 1
    const len = q - ls
    const ch = b[ls]
    if (closing) {
      const e = b.indexOf(GT, q)
      p = e < 0 ? n : e + 1
      if (len === 8 && ch === 118 && attrIs(b, ls, q, 'vertices')) endRun(lt)
      else if (len === 9 && ch === 116 && attrIs(b, ls, q, 'triangles')) endRun(lt)
      else if (len === 4 && ch === 109 && attrIs(b, ls, q, 'mesh')) finishMesh()
      else if (len === 6 && ch === 111 && attrIs(b, ls, q, 'object') && obj) {
        finishMesh()
        objects.set(obj.id, { ...(obj.name !== undefined ? { name: obj.name } : {}), mesh: obj.hasMesh ? obj.mesh : null, components: obj.components })
        obj = null
      } else if (len === 5 && ch === 98 && attrIs(b, ls, q, 'build')) inBuild = false
      continue
    }
    if (len === 6 && ch === 118 && pos && attrIs(b, ls, q, 'vertex')) {
      if (runStart < 0) runStart = lt
      // What every slicer writes, read without collecting the attributes first.
      const quick = quickVertex(b, q, pos, mm)
      if (quick > 0) {
        p = quick
        continue
      }
      p = readAttrs(b, q, at)
      // A missing coordinate is not a number, as Number(undefined) is.
      let x = NaN
      let y = NaN
      let z = NaN
      for (let i = 0; i < at.length; i += 4) {
        const s = at[i]!
        if (at[i + 1]! - s !== 1) continue
        const v = parseNumber(b, at[i + 2]!, at[i + 3]!)
        const k = b[s]
        if (k === 120) x = v
        else if (k === 121) y = v
        else if (k === 122) z = v
      }
      // Checked as doubles, before a float rounds a huge value to infinity.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new ModelScanError('The 3MF model has a vertex that is not a number.')
      pos.push3(x * mm, y * mm, z * mm)
      continue
    }
    if (len === 8 && ch === 116 && idx && attrIs(b, ls, q, 'triangle')) {
      if (runStart < 0) runStart = lt
      const quick = quickTriangle(b, q, idx)
      if (quick > 0) {
        p = quick
        tri++
        continue
      }
      p = readAttrs(b, q, at)
      let v1 = -1
      let v2 = -1
      let v3 = -1
      for (let i = 0; i < at.length; i += 4) {
        const s = at[i]!
        const e = at[i + 1]!
        if (e - s === 2 && b[s] === 118) {
          const v = parseIndex(b, at[i + 2]!, at[i + 3]!)
          const k = b[s + 1]
          if (k === 49) v1 = v
          else if (k === 50) v2 = v
          else if (k === 51) v3 = v
        } else if (e - s > 6 && b[s] === 112 && b[s + 1] === 97) {
          const kind = PAINT[latin1(b, s, e)]
          if (kind && at[i + 3]! > at[i + 2]!) (paint[kind] ??= {})[tri] = latin1(b, at[i + 2]!, at[i + 3]!)
        }
      }
      if (v1 < 0 || v2 < 0 || v3 < 0) throw new ModelScanError('The 3MF model has a triangle that points outside its vertices.')
      idx.push3(v1, v2, v3)
      tri++
      continue
    }
    // Anything else ends a run of vertices or triangles for the skeleton.
    endRun(lt)
    p = readAttrs(b, q, at)
    if (len === 5 && ch === 109 && attrIs(b, ls, q, 'model')) {
      // Lengths in the part are in its unit; everything leaves here in millimeters.
      const unit = attrMap(b, at)['unit']
      mm = unit === undefined ? 1 : (UNIT_MM[unit] ?? 1)
    } else if (len === 6 && ch === 111 && attrIs(b, ls, q, 'object')) {
      const a = attrMap(b, at)
      obj = { id: a['id'] ?? '', ...(a['name'] ? { name: unescapeXml(a['name']) } : {}), components: [], mesh: null, hasMesh: false }
      // A self-closing object has no body.
      if (b[p - 2] === SLASH) {
        objects.set(obj.id, { ...(obj.name !== undefined ? { name: obj.name } : {}), mesh: null, components: [] })
        obj = null
      }
    } else if (len === 4 && ch === 109 && obj && attrIs(b, ls, q, 'mesh')) {
      obj.hasMesh = true
      pos = new Floats()
      idx = new Uints()
      paint = {}
      tri = 0
      sawVertices = false
      sawTriangles = false
    } else if (len === 8 && ch === 118 && pos && attrIs(b, ls, q, 'vertices')) sawVertices = true
    else if (len === 9 && ch === 116 && idx && attrIs(b, ls, q, 'triangles')) sawTriangles = true
    else if (len === 9 && ch === 99 && obj && attrIs(b, ls, q, 'component')) {
      const a = attrMap(b, at)
      obj.components.push({ ...(a['p:path'] ? { path: a['p:path'] } : {}), objectId: a['objectid'] ?? '', transform: inMm(parseTransform(a['transform']), mm) })
    } else if (len === 5 && ch === 98 && attrIs(b, ls, q, 'build')) inBuild = b[p - 2] !== SLASH
    else if (len === 4 && ch === 105 && inBuild && attrIs(b, ls, q, 'item')) {
      const a = attrMap(b, at)
      items.push({ objectId: a['objectid'] ?? '', transform: inMm(parseTransform(a['transform']), mm), printable: a['printable'] !== '0' && a['printable'] !== 'false' })
    }
  }
  if (obj) {
    finishMesh()
    objects.set(obj.id, { ...(obj.name !== undefined ? { name: obj.name } : {}), mesh: obj.hasMesh ? obj.mesh : null, components: obj.components })
  }
  if (skeleton) {
    endRun(n)
    keep.push([keptFrom, n])
    let size = 0
    for (const [s, e] of keep) size += e - s
    const out = new Uint8Array(size)
    let o = 0
    for (const [s, e] of keep) {
      out.set(b.subarray(s, e), o)
      o += e - s
    }
    skeleton(out)
  }
  return { objects, items }
}
