// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Painted triangles. One text per triangle in the format Bambu Studio and
// OrcaSlicer write to 3MF (`paint_color`, `paint_seam`, `paint_supports`):
// a stream of 4-bit codes, written last code first. A code is a leaf (bits 0
// and 1 are 0; the state sits in bits 2 and 3, or both set and the next code
// plus 3) or a split (bits 0 and 1 count the split sides, bits 2 and 3 name
// the special corner) followed by its children. The child layout matches
// sx-core's reader (packages/core/src/paint.rs), which was fitted to
// OrcaSlicer. Pure math, no three.js.

export type V3 = [number, number, number]
export type Tri = [V3, V3, V3]

/** A leaf, or a split into two to four children in the order sx-core reads them. */
export type PaintNode = { state: number } | { splits: 1 | 2 | 3; special: 0 | 1 | 2; kids: PaintNode[] }

export const isLeaf = (n: PaintNode): n is { state: number } => 'state' in n

/** Deepest nesting written or read. */
export const MAX_PAINT_DEPTH = 12

const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]

/** Corners of each child of a split, already rotated the way the child's own codes expect. */
export function childCorners(v: Tri, splits: 1 | 2 | 3, special: 0 | 1 | 2): Tri[] {
  const p: Tri = [v[special], v[(special + 1) % 3] as V3, v[(special + 2) % 3] as V3]
  const mA = mid(p[0], p[1])
  const mB = mid(p[2], p[0])
  const mC = mid(p[1], p[2])
  const rot = (c: Tri, k: number): Tri => (k === 0 ? c : ([c[1], c[2], c[0]] as Tri))
  if (splits === 1) return [rot([p[0], mC, p[2]], 1), [p[0], p[1], mC]]
  if (splits === 2) return [rot([mB, p[1], p[2]], 1), [mA, p[1], mB], [p[0], mA, mB]]
  return [[mA, mC, mB], rot([mB, mC, p[2]], 1), [mA, p[1], mC], [p[0], mA, mB]]
}

// ---- text <-> tree ----

function nibbles(text: string): number[] | null {
  const out: number[] = []
  const s = text.trim()
  for (let i = s.length - 1; i >= 0; i--) {
    const d = Number.parseInt(s[i] as string, 16)
    if (Number.isNaN(d)) return null
    out.push(d)
  }
  return out
}

/** Parses a paint text. Null when it is malformed or nests too deep. Trailing codes are ignored, as sx-core does. */
export function decodeTree(text: string): PaintNode | null {
  const stream = nibbles(text)
  if (!stream || stream.length === 0) return null
  let at = 0
  const node = (depth: number): PaintNode | null => {
    const code = stream[at++]
    if (code === undefined) return null
    const splits = code & 3
    const special = code >> 2
    if (splits === 0) {
      if (special === 3) {
        const ext = stream[at++]
        return ext === undefined ? null : { state: ext + 3 }
      }
      return { state: special }
    }
    if (depth >= MAX_PAINT_DEPTH || special > 2) return null
    const count = splits + 1
    const kids: PaintNode[] = []
    for (let i = 0; i < count; i++) {
      const k = node(depth + 1)
      if (!k) return null
      kids.push(k)
    }
    return { splits: splits as 1 | 2 | 3, special: special as 0 | 1 | 2, kids }
  }
  return node(0)
}

/** Writes a tree as paint text. A single unpainted leaf gives null: write no attribute. */
export function encodeTree(root: PaintNode): string | null {
  if (isLeaf(root) && root.state === 0) return null
  const out: number[] = []
  const walk = (n: PaintNode): void => {
    if (isLeaf(n)) {
      if (n.state < 3) out.push(n.state << 2)
      else {
        out.push(0b1100)
        out.push(n.state - 3)
      }
      return
    }
    out.push((n.special << 2) | n.splits)
    for (const k of n.kids) walk(k)
  }
  walk(root)
  return out
    .reverse()
    .map((d) => d.toString(16).toUpperCase())
    .join('')
}

// ---- geometry of a tree ----

export interface PaintLeaf {
  v: Tri
  state: number
}

/** Every leaf piece of a triangle with its state, unpainted pieces included. */
export function leavesOf(tri: Tri, node: PaintNode, out: PaintLeaf[] = []): PaintLeaf[] {
  if (isLeaf(node)) {
    out.push({ v: tri, state: node.state })
    return out
  }
  const cs = childCorners(tri, node.splits, node.special)
  node.kids.forEach((k, i) => leavesOf(cs[i] as Tri, k, out))
  return out
}

/** How many leaf pieces of a tree are painted (state other than 0), without building them. */
export function paintedLeafCount(node: PaintNode): number {
  if (isLeaf(node)) return node.state === 0 ? 0 : 1
  let n = 0
  for (const k of node.kids) n += paintedLeafCount(k)
  return n
}

/** Calls `fn` with the corners and state of every painted leaf piece of a triangle, in the order leavesOf lists them. */
export function forEachPaintedLeaf(tri: Tri, node: PaintNode, fn: (v: Tri, state: number) => void): void {
  if (isLeaf(node)) {
    if (node.state !== 0) fn(tri, node.state)
    return
  }
  const cs = childCorners(tri, node.splits, node.special)
  for (let i = 0; i < node.kids.length; i++) forEachPaintedLeaf(cs[i] as Tri, node.kids[i] as PaintNode, fn)
}

/** Merges children that are all leaves of one state, so strokes do not grow the text for nothing. */
export function simplify(node: PaintNode): PaintNode {
  if (isLeaf(node)) return node
  const kids = node.kids.map(simplify)
  const first = kids[0]
  if (first && isLeaf(first) && kids.every((k) => isLeaf(k) && k.state === first.state)) return { state: first.state }
  return { ...node, kids }
}

// ---- regions ----

/** A volume or slab to paint, in the mesh's own frame. */
export interface PaintRegion {
  /** `inside`: the whole triangle is in the region. `outside`: none of it. Otherwise `partial`. */
  classify(tri: Tri): 'inside' | 'outside' | 'partial'
  contains(p: V3): boolean
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Closest point of triangle abc to p (Ericson, Real-Time Collision Detection). */
export function closestPointOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b)
  const d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]
  }
  const cp = sub(p, c)
  const d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]
  }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom, w = vc * denom
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

/** Sphere brush. */
export function sphereRegion(center: V3, radius: number): PaintRegion {
  const r2 = radius * radius
  const d2 = (p: V3): number => {
    const d = sub(p, center)
    return dot(d, d)
  }
  return {
    classify(t) {
      if (d2(t[0]) <= r2 && d2(t[1]) <= r2 && d2(t[2]) <= r2) return 'inside'
      return d2(closestPointOnTriangle(center, t[0], t[1], t[2])) > r2 ? 'outside' : 'partial'
    },
    contains: (p) => d2(p) <= r2,
  }
}

/**
 * Circle brush: an infinite cylinder of `radius` around the line through `origin` along `dir`
 * (the view direction). With `frontOnly`, triangles facing away from the viewer are left alone.
 */
export function cylinderRegion(origin: V3, dir: V3, radius: number, frontOnly = false): PaintRegion {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
  const d: V3 = [dir[0] / l, dir[1] / l, dir[2] / l]
  const r2 = radius * radius
  const flat = (p: V3): V3 => {
    const q = sub(p, origin)
    const k = dot(q, d)
    return [q[0] - k * d[0], q[1] - k * d[1], q[2] - k * d[2]]
  }
  const zero: V3 = [0, 0, 0]
  const facing = (t: Tri): boolean => {
    const n = cross(sub(t[1], t[0]), sub(t[2], t[0]))
    return dot(n, d) < 0
  }
  return {
    classify(t) {
      if (frontOnly && !facing(t)) return 'outside'
      const a = flat(t[0]), b = flat(t[1]), c = flat(t[2])
      if (dot(a, a) <= r2 && dot(b, b) <= r2 && dot(c, c) <= r2) return 'inside'
      const cp = closestPointOnTriangle(zero, a, b, c)
      return dot(cp, cp) > r2 ? 'outside' : 'partial'
    },
    contains(p) {
      const q = flat(p)
      return dot(q, q) <= r2
    },
  }
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Height range: points with `lo <= up . p <= hi`, where `up` is the world up direction in the mesh frame. */
export function slabRegion(up: V3, lo: number, hi: number): PaintRegion {
  const l = Math.hypot(up[0], up[1], up[2]) || 1
  const n: V3 = [up[0] / l, up[1] / l, up[2] / l]
  return {
    classify(t) {
      const h = [dot(n, t[0]), dot(n, t[1]), dot(n, t[2])]
      const mn = Math.min(...h), mx = Math.max(...h)
      if (mn >= lo && mx <= hi) return 'inside'
      return mx < lo || mn > hi ? 'outside' : 'partial'
    },
    contains: (p) => {
      const h = dot(n, p)
      return h >= lo && h <= hi
    },
  }
}

/**
 * Limits a region to points that pass `allowed` (the clipping plane of the painter: what Orca skips is not painted). A
 * triangle with no allowed sample point (corners and center) is outside, one with only some is partial.
 */
export function withPointFilter(region: PaintRegion, allowed: (p: V3) => boolean): PaintRegion {
  return {
    classify(t) {
      const base = region.classify(t)
      if (base === 'outside') return 'outside'
      const c: V3 = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3]
      let n = 0
      for (const p of [t[0], t[1], t[2], c]) if (allowed(p)) n++
      if (n === 0) return 'outside'
      return n === 4 ? base : 'partial'
    },
    contains: (p) => region.contains(p) && allowed(p),
  }
}

// ---- painting a triangle ----

export interface BrushOptions {
  /** Longest edge a piece may have before a stroke stops splitting it, in mm. Smaller paints finer detail. */
  minEdge: number
  /** Splitting off. Whole triangles are painted when their center is inside the region. */
  noSplit?: boolean
}

const edge = (t: Tri): number => Math.max(Math.hypot(...sub(t[0], t[1])), Math.hypot(...sub(t[1], t[2])), Math.hypot(...sub(t[2], t[0])))
const centroid = (t: Tri): V3 => [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3]

/**
 * Paints `state` into the part of a triangle inside `region`, splitting pieces the region cuts
 * until they are no longer than `minEdge`. State 0 erases. Returns the new tree (simplified), or
 * the same node when nothing changed.
 */
export function paintTriangle(tri: Tri, node: PaintNode, region: PaintRegion, state: number, opts: BrushOptions): PaintNode {
  const out = paintNode(tri, node, region, state, opts, 0)
  return out === node ? node : simplify(out)
}

function paintNode(tri: Tri, node: PaintNode, region: PaintRegion, state: number, opts: BrushOptions, depth: number): PaintNode {
  if (!isLeaf(node)) {
    const cs = childCorners(tri, node.splits, node.special)
    let changed = false
    const kids = node.kids.map((k, i) => {
      const nk = paintNode(cs[i] as Tri, k, region, state, opts, depth + 1)
      if (nk !== k) changed = true
      return nk
    })
    return changed ? { ...node, kids } : node
  }
  const c = region.classify(tri)
  if (c === 'outside') return node
  if (c === 'inside') return node.state === state ? node : { state }
  // Partial: split while the piece is larger than the brush resolution, else decide by its center.
  if (!opts.noSplit && depth < MAX_PAINT_DEPTH - 1 && edge(tri) > opts.minEdge) {
    const split: PaintNode = { splits: 3, special: 0, kids: [{ state: node.state }, { state: node.state }, { state: node.state }, { state: node.state }] }
    return paintNode(tri, split, region, state, opts, depth)
  }
  if (!region.contains(centroid(tri))) return node
  return node.state === state ? node : { state }
}

/** Replaces the state of every leaf that has `from` with `to`. Used by fill. */
export function replaceState(node: PaintNode, from: number, to: number): PaintNode {
  if (isLeaf(node)) return node.state === from ? { state: to } : node
  let changed = false
  const kids = node.kids.map((k) => {
    const nk = replaceState(k, from, to)
    if (nk !== k) changed = true
    return nk
  })
  return changed ? simplify({ ...node, kids }) : node
}

/** True when some leaf has this state. */
export function hasState(node: PaintNode, state: number): boolean {
  return isLeaf(node) ? node.state === state : node.kids.some((k) => hasState(k, state))
}

/** The state of the leaf that contains point `p` (nearest leaf when p is off the triangle). */
export function stateAt(tri: Tri, node: PaintNode, p: V3): number {
  if (isLeaf(node)) return node.state
  const cs = childCorners(tri, node.splits, node.special)
  let best = 0
  let bestD = Infinity
  cs.forEach((c, i) => {
    const q = closestPointOnTriangle(p, c[0], c[1], c[2])
    const d = dot(sub(q, p), sub(q, p))
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return stateAt(cs[best] as Tri, node.kids[best] as PaintNode, p)
}

import { adjacencyOf } from './faces'

// ---- mesh level ----

/** Painted triangles of one part and one kind of paint (color, seam, supports), by triangle index. */
export type PaintMap = Map<number, PaintNode>

// ---- paint texts read in place ----
// The overlay draws a part's paint straight from its texts, and a triangle is decoded into a tree only when a tool
// touches it: a model with hundreds of thousands of painted pieces kept them all as objects next to the texts, and
// decoding them left garbage the page held for a long time.

/** The 4-bit code at stream position k of a text read last character first (from index hi down to lo), or -1. */
function codeAt(text: string, hi: number, k: number): number {
  const c = text.charCodeAt(hi - k)
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 65 && c <= 70) return c - 55
  if (c >= 97 && c <= 102) return c - 87
  return -1
}

/** Whitespace as String.prototype.trim sees it, for the codes a paint text may carry. */
const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0xfeff || c === 0x2028 || c === 0x2029 || (c >= 0x2000 && c <= 0x200a) || c === 0x1680 || c === 0x202f || c === 0x205f || c === 0x3000

// One stack for every walk: corners per depth (9 numbers) and the split's points and midpoints (18 numbers).
const CORNERS = new Float64Array(9 * (MAX_PAINT_DEPTH + 2))
const POINTS = new Float64Array(18 * (MAX_PAINT_DEPTH + 2))
let walkText = ''
let walkHi = 0
let walkLen = 0
let walkAt = 0

/** Reads one node at walkAt: the painted leaves under it, or -1 when malformed; `fn` is called for each. */
function walkNode(depth: number, fn: ((corners: Float64Array, offset: number, state: number) => void) | null): number {
  if (walkAt >= walkLen) return -1
  const code = codeAt(walkText, walkHi, walkAt++)
  if (code < 0) return -1
  const splits = code & 3
  const special = code >> 2
  if (splits === 0) {
    let state = special
    if (special === 3) {
      if (walkAt >= walkLen) return -1
      const ext = codeAt(walkText, walkHi, walkAt++)
      if (ext < 0) return -1
      state = ext + 3
    }
    if (state === 0) return 0
    if (fn) fn(CORNERS, 9 * depth, state)
    return 1
  }
  if (depth >= MAX_PAINT_DEPTH || special > 2) return -1
  // The same corners childCorners gives, in the same order.
  if (fn) {
    const c = 9 * depth
    const q = 18 * depth
    for (let k = 0; k < 3; k++) {
      const from = c + 3 * ((special + k) % 3)
      POINTS[q + 3 * k] = CORNERS[from]!
      POINTS[q + 3 * k + 1] = CORNERS[from + 1]!
      POINTS[q + 3 * k + 2] = CORNERS[from + 2]!
    }
    // mA = mid(p0, p1), mB = mid(p2, p0), mC = mid(p1, p2), at points 3, 4 and 5.
    for (let a = 0; a < 3; a++) {
      POINTS[q + 9 + a] = (POINTS[q + a]! + POINTS[q + 3 + a]!) / 2
      POINTS[q + 12 + a] = (POINTS[q + 6 + a]! + POINTS[q + a]!) / 2
      POINTS[q + 15 + a] = (POINTS[q + 3 + a]! + POINTS[q + 6 + a]!) / 2
    }
  }
  const kids = CHILDREN[splits as 1 | 2 | 3]
  let n = 0
  for (const kid of kids) {
    if (fn) {
      const q = 18 * depth
      const c = 9 * (depth + 1)
      for (let k = 0; k < 3; k++) {
        const from = q + 3 * kid[k]!
        CORNERS[c + 3 * k] = POINTS[from]!
        CORNERS[c + 3 * k + 1] = POINTS[from + 1]!
        CORNERS[c + 3 * k + 2] = POINTS[from + 2]!
      }
    }
    const m = walkNode(depth + 1, fn)
    if (m < 0) return -1
    n += m
  }
  return n
}

/**
 * Each child's corners as indices into [p0, p1, p2, mA, mB, mC], already rotated, as childCorners lists them:
 * rot([a, b, c]) is [b, c, a].
 */
const CHILDREN: Record<1 | 2 | 3, readonly (readonly number[])[]> = {
  1: [[5, 2, 0], [0, 1, 5]],
  2: [[1, 2, 4], [3, 1, 4], [0, 3, 4]],
  3: [[3, 5, 4], [5, 2, 4], [3, 1, 5], [0, 3, 4]],
}

/**
 * Sets the walk up on a text the way decodeTree reads it (trimmed, last character first). False when decodeTree would
 * refuse it for its characters: empty, or not all hex digits.
 */
function startWalk(text: string): boolean {
  let lo = 0
  let hi = text.length - 1
  while (lo <= hi && isSpace(text.charCodeAt(lo))) lo++
  while (hi >= lo && isSpace(text.charCodeAt(hi))) hi--
  walkText = text
  walkHi = hi
  walkLen = hi - lo + 1
  walkAt = 0
  if (walkLen <= 0) return false
  // decodeTree refuses a text with any character that is not a hex digit, read or not.
  for (let k = 0; k < walkLen; k++) if (codeAt(text, hi, k) < 0) return false
  return true
}

/** The painted leaf pieces of a paint text, without decoding it; -1 when decodeTree would refuse it. */
export function paintTextLeafCount(text: string): number {
  return startWalk(text) ? walkNode(0, null) : -1
}

/**
 * Calls `fn` for every painted leaf piece of a paint text on triangle `tri` (its corners as 9 numbers), with the
 * piece's corners at corners[offset..offset + 8]; the same pieces in the same order as forEachPaintedLeaf on its
 * decoded tree. Nothing is allocated. Returns the count, or -1 when the text is malformed (then `fn` may have run).
 */
export function forEachPaintedLeafOfText(text: string, tri: ArrayLike<number>, fn: (corners: Float64Array, offset: number, state: number) => void): number {
  if (!startWalk(text)) return -1
  for (let k = 0; k < 9; k++) CORNERS[k] = tri[k]!
  return walkNode(0, fn)
}

/**
 * A paint map that keeps each triangle's paint text as given and decodes it into a tree the first time it is read.
 * Iterating it decodes everything (only whole-part tools do); the overlay reads `texts` directly.
 */
export class LazyPaintMap extends Map<number, PaintNode> {
  /** The triangles not decoded yet, by triangle, as their texts. */
  readonly texts = new Map<number, string>()

  override get(t: number): PaintNode | undefined {
    const n = super.get(t)
    if (n !== undefined) return n
    const text = this.texts.get(t)
    if (text === undefined) return undefined
    this.texts.delete(t)
    const tree = decodeTree(text)
    if (!tree) return undefined
    super.set(t, tree)
    return tree
  }
  override has(t: number): boolean {
    return super.has(t) || this.texts.has(t)
  }
  override set(t: number, n: PaintNode): this {
    this.texts?.delete(t)
    return super.set(t, n)
  }
  override delete(t: number): boolean {
    const a = this.texts.delete(t)
    return super.delete(t) || a
  }
  override clear(): void {
    this.texts.clear()
    super.clear()
  }
  override get size(): number {
    return super.size + this.texts.size
  }
  /** Decodes every triangle still kept as text. */
  private decodeAll(): void {
    for (const t of [...this.texts.keys()]) this.get(t)
  }
  override entries(): MapIterator<[number, PaintNode]> {
    this.decodeAll()
    return super.entries()
  }
  override keys(): MapIterator<number> {
    this.decodeAll()
    return super.keys()
  }
  override values(): MapIterator<PaintNode> {
    this.decodeAll()
    return super.values()
  }
  override [Symbol.iterator](): MapIterator<[number, PaintNode]> {
    return this.entries()
  }
  override forEach(fn: (value: PaintNode, key: number, map: Map<number, PaintNode>) => void, thisArg?: unknown): void {
    this.decodeAll()
    super.forEach(fn, thisArg)
  }
}

/** The triangles of a lazy map that are trees already, without decoding the rest. */
export function decodedEntries(map: LazyPaintMap): IterableIterator<[number, PaintNode]> {
  return Map.prototype.entries.call(map) as IterableIterator<[number, PaintNode]>
}

/**
 * Reads texts from a 3MF reader into a lazy map: each is checked without decoding it, malformed ones are listed in
 * `bad`, and a text that is one unpainted leaf is left out, as readPaintTexts does.
 */
export function lazyPaintTexts(texts: Record<number, string>): { map: LazyPaintMap; bad: number[] } {
  const map = new LazyPaintMap()
  const bad: number[] = []
  for (const k in texts) {
    const text = texts[k]!
    const t = Number(k)
    const n = paintTextLeafCount(text)
    if (n < 0) bad.push(t)
    else if (n > 0 || !isRootUnpainted(text)) map.texts.set(t, text)
  }
  return { map, bad }
}

/** Whether a valid text is a single unpainted leaf (the only valid text with no painted piece that readPaintTexts drops). */
function isRootUnpainted(text: string): boolean {
  startWalk(text)
  const code = codeAt(walkText, walkHi, 0)
  return (code & 3) === 0 && code >> 2 === 0
}

export function trianglePoints(positions: ArrayLike<number>, indices: ArrayLike<number>, t: number): Tri {
  const p = (k: number): V3 => {
    const i = 3 * (indices[3 * t + k] ?? 0)
    return [positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0]
  }
  return [p(0), p(1), p(2)]
}

/** Text per painted triangle, ready for the 3MF writer. Unpainted triangles are left out. */
export function paintTexts(map: PaintMap): Record<number, string> {
  const out: Record<number, string> = {}
  for (const [t, n] of map) {
    const s = encodeTree(n)
    if (s) out[t] = s
  }
  return out
}

/** Reads texts from a 3MF reader. Malformed entries are skipped and listed in `bad`. */
export function readPaintTexts(texts: Record<number, string>): { map: PaintMap; bad: number[] } {
  const map: PaintMap = new Map()
  const bad: number[] = []
  for (const [k, text] of Object.entries(texts)) {
    const t = Number(k)
    const n = decodeTree(text)
    if (!n) bad.push(t)
    else if (!(isLeaf(n) && n.state === 0)) map.set(t, n)
  }
  return { map, bad }
}

export interface PaintMesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
}

const gridCache = new WeakMap<object, TriangleGrid>()

/** Uniform grid over triangle bounding boxes, so a brush looks at nearby triangles only. */
export class TriangleGrid {
  private readonly cell: number
  private readonly min: V3
  private readonly dims: [number, number, number]
  private readonly bins = new Map<number, number[]>()

  constructor(mesh: PaintMesh) {
    const n = Math.floor(mesh.indices.length / 3)
    const lo: V3 = [Infinity, Infinity, Infinity]
    const hi: V3 = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = mesh.positions[i + a] ?? 0
        if (v < lo[a]!) lo[a] = v
        if (v > hi[a]!) hi[a] = v
      }
    }
    if (!Number.isFinite(lo[0])) {
      lo.fill(0)
      hi.fill(1)
    }
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1
    // About 40 cells along the diagonal, fewer when the mesh is small.
    this.cell = Math.max(diag / 40, 1e-3)
    this.min = lo
    this.dims = [Math.ceil((hi[0] - lo[0]) / this.cell) + 1, Math.ceil((hi[1] - lo[1]) / this.cell) + 1, Math.ceil((hi[2] - lo[2]) / this.cell) + 1]
    for (let t = 0; t < n; t++) {
      const tri = trianglePoints(mesh.positions, mesh.indices, t)
      const [a0, b0] = this.range(tri, 0)
      const [a1, b1] = this.range(tri, 1)
      const [a2, b2] = this.range(tri, 2)
      for (let x = a0; x <= b0; x++) for (let y = a1; y <= b1; y++) for (let z = a2; z <= b2; z++) {
        const k = this.key(x, y, z)
        const list = this.bins.get(k)
        if (list) list.push(t)
        else this.bins.set(k, [t])
      }
    }
  }

  private key(x: number, y: number, z: number): number {
    return (z * this.dims[1] + y) * this.dims[0] + x
  }

  private range(tri: Tri, a: number): [number, number] {
    const v = [tri[0][a] as number, tri[1][a] as number, tri[2][a] as number]
    const lo = Math.floor((Math.min(...v) - this.min[a]!) / this.cell)
    const hi = Math.floor((Math.max(...v) - this.min[a]!) / this.cell)
    return [Math.max(0, lo), Math.min(this.dims[a]! - 1, hi)]
  }

  /** Triangles whose boxes touch the box lo..hi (superset of those inside it). */
  query(lo: V3, hi: V3): number[] {
    const r = (a: number): [number, number] => [
      Math.max(0, Math.floor((lo[a]! - this.min[a]!) / this.cell)),
      Math.min(this.dims[a]! - 1, Math.floor((hi[a]! - this.min[a]!) / this.cell)),
    ]
    const [a0, b0] = r(0)
    const [a1, b1] = r(1)
    const [a2, b2] = r(2)
    const seen = new Set<number>()
    for (let x = a0; x <= b0; x++) for (let y = a1; y <= b1; y++) for (let z = a2; z <= b2; z++) {
      for (const t of this.bins.get(this.key(x, y, z)) ?? []) seen.add(t)
    }
    return [...seen]
  }
}

export function gridFor(mesh: PaintMesh): TriangleGrid {
  let g = gridCache.get(mesh.indices as object)
  if (!g) {
    g = new TriangleGrid(mesh)
    gridCache.set(mesh.indices as object, g)
  }
  return g
}

const UNPAINTED: PaintNode = { state: 0 }

function faceNormal(mesh: PaintMesh, t: number): V3 {
  const tri = trianglePoints(mesh.positions, mesh.indices, t)
  const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))
  const l = Math.hypot(n[0], n[1], n[2]) || 1
  return [n[0] / l, n[1] / l, n[2] / l]
}

/**
 * One brush dab the way OrcaSlicer's `select_patch` does it: start at the triangle under the pointer
 * and spread to neighbors that face the viewer (`normal . dir < 0`, `dir` from the camera to the hit),
 * painting every triangle the region touches and continuing only through those. Nothing is painted
 * behind a thin wall or on a disconnected surface, and no depth buffer is involved. The start triangle
 * is taken whatever way it faces. Returns the indexes of the triangles that changed.
 */
export function paintPatch(mesh: PaintMesh, map: PaintMap, start: number, region: PaintRegion, state: number, opts: BrushOptions, dir: V3, record?: PaintRecorder, gate?: (triangle: number) => boolean): number[] {
  const adj = adjacencyOf(mesh.positions, mesh.indices)
  const changed: number[] = []
  const visited = new Set<number>()
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i] as number
    if (visited.has(t)) continue
    visited.add(t)
    // Overhang-only painting: a triangle the gate refuses is left alone and nothing spreads through it.
    if (gate && !gate(t)) continue
    const tri = trianglePoints(mesh.positions, mesh.indices, t)
    if (region.classify(tri) === 'outside') continue
    const before = map.get(t) ?? UNPAINTED
    const after = paintTriangle(tri, before, region, state, opts)
    if (after !== before) {
      record?.(t, map.get(t))
      if (isLeaf(after) && after.state === 0) map.delete(t)
      else map.set(t, after)
      changed.push(t)
    }
    for (let e = 0; e < 3; e++) {
      const o = adj[3 * t + e] ?? -1
      if (o >= 0 && !visited.has(o) && dot(faceNormal(mesh, o), dir) < 0) queue.push(o)
    }
  }
  return changed
}

/** Orca's edge limit for a brush of this radius: `min(radius / 5, 0.05)` mm. */
export function autoDetail(radiusMm: number): number {
  return Math.min(radiusMm / 5, 0.05)
}

/** Sets the leaf piece that holds point `p` to `state` (the pointer tool: one piece at a time). */
export function paintLeafAt(tri: Tri, node: PaintNode, p: V3, state: number): PaintNode {
  if (isLeaf(node)) return node.state === state ? node : { state }
  const cs = childCorners(tri, node.splits, node.special)
  let best = 0
  let bestD = Infinity
  cs.forEach((c, i) => {
    const q = closestPointOnTriangle(p, c[0], c[1], c[2])
    const d = dot(sub(q, p), sub(q, p))
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  const kid = paintLeafAt(cs[best] as Tri, node.kids[best] as PaintNode, p, state)
  if (kid === node.kids[best]) return node
  const kids = node.kids.slice()
  kids[best] = kid
  return simplify({ ...node, kids })
}

/**
 * One brush dab: paints `state` in `region` on the triangles near `bounds`.
 * Returns the indexes of the triangles that changed. The map is updated in place.
 */
export type PaintRecorder = (triangle: number, before: PaintNode | undefined) => void

export function paintDab(mesh: PaintMesh, map: PaintMap, bounds: [V3, V3], region: PaintRegion, state: number, opts: BrushOptions, record?: PaintRecorder): number[] {
  const changed: number[] = []
  for (const t of gridFor(mesh).query(bounds[0], bounds[1])) {
    const tri = trianglePoints(mesh.positions, mesh.indices, t)
    const before = map.get(t) ?? UNPAINTED
    const after = paintTriangle(tri, before, region, state, opts)
    if (after === before) continue
    record?.(t, map.get(t))
    if (isLeaf(after) && after.state === 0) map.delete(t)
    else map.set(t, after)
    changed.push(t)
  }
  return changed
}

/**
 * Bucket fill (Orca's `bucket_fill_select_triangles`): every leaf that has the state under the seed point, in triangles connected to the
 * seed through shared edges, takes `state`. Pieces inside split triangles are matched by leaf, so
 * a fill stops at painted borders inside a triangle. Returns the changed triangle indexes.
 */
export function fillConnected(mesh: PaintMesh, map: PaintMap, seed: number, seedPoint: V3, state: number, angleDeg = -1, record?: PaintRecorder): number[] {
  const adj = adjacencyOf(mesh.positions, mesh.indices)
  const seedNode = map.get(seed) ?? UNPAINTED
  const target = stateAt(trianglePoints(mesh.positions, mesh.indices, seed), seedNode, seedPoint)
  if (target === state) return []
  const limit = angleDeg < 0 ? -1 : Math.cos((angleDeg * Math.PI) / 180) - 1e-6
  const seen = new Set<number>([seed])
  const queue = [seed]
  const changed: number[] = []
  while (queue.length) {
    const t = queue.pop() as number
    const before = map.get(t) ?? UNPAINTED
    if (!hasState(before, target)) continue
    const after = replaceState(before, target, state)
    if (after !== before) {
      record?.(t, map.get(t))
      if (isLeaf(after) && after.state === 0) map.delete(t)
      else map.set(t, after)
      changed.push(t)
    }
    for (let e = 0; e < 3; e++) {
      const o = adj[3 * t + e] ?? -1
      if (o >= 0 && !seen.has(o)) {
        seen.add(o)
        if (limit < 0 || Math.min(1, Math.max(0, dot(faceNormal(mesh, t), faceNormal(mesh, o)))) >= limit) queue.push(o)
      }
    }
  }
  return changed
}

/**
 * Smart fill: whole triangles connected to the seed while the bend between neighbors stays within
 * `angleDeg` (Orca measures it as the dot product of neighbor normals clamped to 0 to 1; a negative
 * angle removes the limit). The seed triangle is always painted. Returns the changed triangle indexes.
 */
export function fillByAngle(mesh: PaintMesh, map: PaintMap, seed: number, state: number, angleDeg: number, record?: PaintRecorder, gate?: (triangle: number) => boolean): number[] {
  const adj = adjacencyOf(mesh.positions, mesh.indices)
  const normal = (t: number): V3 => {
    const tri = trianglePoints(mesh.positions, mesh.indices, t)
    const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))
    const l = Math.hypot(n[0], n[1], n[2]) || 1
    return [n[0] / l, n[1] / l, n[2] / l]
  }
  const cos = angleDeg < 0 ? -1 : Math.cos((angleDeg * Math.PI) / 180) - 1e-6
  const seen = new Set<number>([seed])
  const queue = [seed]
  const changed: number[] = []
  while (queue.length) {
    const t = queue.pop() as number
    if (gate && !gate(t)) continue
    const before = map.get(t) ?? UNPAINTED
    if (!(isLeaf(before) && before.state === state)) {
      record?.(t, map.get(t))
      if (state === 0) map.delete(t)
      else map.set(t, { state })
      changed.push(t)
    }
    const n = normal(t)
    for (let e = 0; e < 3; e++) {
      const o = adj[3 * t + e] ?? -1
      if (o >= 0 && !seen.has(o)) {
        seen.add(o)
        if (Math.min(1, Math.max(0, dot(n, normal(o)))) >= cos) queue.push(o)
      }
    }
  }
  return changed
}

/** Every leaf with state `from` becomes `to` in the triangles `allowed` accepts (PrusaSlicer's color replace). Returns the changed triangles. */
export function replaceEverywhere(mesh: PaintMesh, map: PaintMap, from: number, to: number, allowed?: (triangle: number) => boolean, record?: PaintRecorder): number[] {
  const changed: number[] = []
  const n = Math.floor(mesh.indices.length / 3)
  if (from === 0) {
    // Unpainted triangles are not in the map: paint those the filter allows.
    for (let t = 0; t < n; t++) {
      if (map.has(t) || (allowed && !allowed(t))) continue
      record?.(t, undefined)
      if (to !== 0) map.set(t, { state: to })
      changed.push(t)
    }
  }
  for (const [t, node] of [...map]) {
    if (allowed && !allowed(t)) continue
    if (!hasState(node, from)) continue
    const after = replaceState(node, from, to)
    if (after === node) continue
    record?.(t, node)
    if (isLeaf(after) && after.state === 0) map.delete(t)
    else map.set(t, after)
    changed.push(t)
  }
  return changed
}

function setLeaves(tri: Tri, node: PaintNode, next: (leaf: PaintLeaf, index: number) => number, counter: { i: number }): PaintNode {
  if (isLeaf(node)) {
    const i = counter.i++
    const s = next({ v: tri, state: node.state }, i)
    return s === node.state ? node : { state: s }
  }
  const cs = childCorners(tri, node.splits, node.special)
  let changed = false
  const kids = node.kids.map((k, j) => {
    const nk = setLeaves(cs[j] as Tri, k, next, counter)
    if (nk !== k) changed = true
    return nk
  })
  return changed ? { ...node, kids } : node
}

const triArea = (t: Tri): number => {
  const c = cross(sub(t[1], t[0]), sub(t[2], t[0]))
  return Math.hypot(c[0], c[1], c[2]) / 2
}

/**
 * Gap fill as in Orca and Bambu Studio: patches (connected pieces of one state) whose area is under `areaMm2` take the
 * state of a neighboring patch (the lowest state number, as Orca's ordered set does, so a patch next to unpainted surface
 * becomes unpainted). Pieces touch when they share an edge or lie on the same edge of the original mesh, which also joins
 * pieces on both sides of a split triangle's T-junction. Returns the changed triangles.
 */
export function gapFill(mesh: PaintMesh, map: PaintMap, areaMm2: number, record?: PaintRecorder): number[] {
  if (areaMm2 <= 0) return []
  const n = Math.floor(mesh.indices.length / 3)
  const q = (p: V3): string => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`
  const segKey = (a: V3, b: V3): string => {
    const ka = q(a)
    const kb = q(b)
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
  }
  const onSegment = (p: V3, a: V3, b: V3): boolean => {
    const ab = sub(b, a)
    const l2 = dot(ab, ab)
    if (l2 === 0) return false
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2))
    const c: V3 = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]
    const d = sub(p, c)
    return dot(d, d) < 1e-8
  }
  interface Piece { tri: number; index: number; state: number; area: number }
  const pieces: Piece[] = []
  const groups = new Map<string, number[]>()
  const add = (k: string, id: number): void => {
    const g = groups.get(k)
    if (g) g.push(id)
    else groups.set(k, [id])
  }
  for (let t = 0; t < n; t++) {
    const orig = trianglePoints(mesh.positions, mesh.indices, t)
    const node = map.get(t) ?? UNPAINTED
    const leaves = leavesOf(orig, node)
    leaves.forEach((leaf, index) => {
      const id = pieces.length
      pieces.push({ tri: t, index, state: leaf.state, area: triArea(leaf.v) })
      for (let e = 0; e < 3; e++) {
        const a = leaf.v[e] as V3
        const b = leaf.v[(e + 1) % 3] as V3
        add(`s:${segKey(a, b)}`, id)
        for (let oe = 0; oe < 3; oe++) {
          const pa = orig[oe] as V3
          const pb = orig[(oe + 1) % 3] as V3
          if (onSegment(a, pa, pb) && onSegment(b, pa, pb)) add(`o:${segKey(pa, pb)}`, id)
        }
      }
    })
  }
  // Patches: connected pieces of one state.
  const patch = new Int32Array(pieces.length).fill(-1)
  const neighbors: Set<number>[] = pieces.map(() => new Set<number>())
  for (const [key, g] of groups) {
    const orig = key.startsWith('o:')
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i] as number
        const b = g[j] as number
        // Pieces of one triangle along its original edge are not neighbors through that edge; shared segments join them.
        if (orig && (pieces[a] as Piece).tri === (pieces[b] as Piece).tri) continue
        neighbors[a]?.add(b)
        neighbors[b]?.add(a)
      }
    }
  }
  const patches: { members: number[]; state: number; area: number; touching: Set<number> }[] = []
  for (let i = 0; i < pieces.length; i++) {
    if (patch[i] !== -1) continue
    const p = { members: [] as number[], state: (pieces[i] as Piece).state, area: 0, touching: new Set<number>() }
    const stack = [i]
    patch[i] = patches.length
    while (stack.length) {
      const c = stack.pop() as number
      p.members.push(c)
      p.area += (pieces[c] as Piece).area
      for (const o of neighbors[c] ?? []) {
        if ((pieces[o] as Piece).state === p.state) {
          if (patch[o] === -1) {
            patch[o] = patches.length
            stack.push(o)
          }
        } else p.touching.add((pieces[o] as Piece).state)
      }
    }
    patches.push(p)
  }
  // New state per piece for fragments that have a neighbor.
  const newState = new Map<number, number>()
  for (const p of patches) {
    if (p.area >= areaMm2 || p.touching.size === 0) continue
    const to = Math.min(...p.touching)
    for (const m of p.members) newState.set(m, to)
  }
  if (newState.size === 0) return []
  const changed: number[] = []
  let id = 0
  for (let t = 0; t < n; t++) {
    const node = map.get(t) ?? UNPAINTED
    const count = leavesOf(trianglePoints(mesh.positions, mesh.indices, t), node).length
    const base = id
    id += count
    let touched = false
    for (let k = 0; k < count; k++) if (newState.has(base + k)) touched = true
    if (!touched) continue
    const after = simplify(setLeaves(trianglePoints(mesh.positions, mesh.indices, t), node, (leaf, i) => newState.get(base + i) ?? leaf.state, { i: 0 }))
    if (JSON.stringify(after) === JSON.stringify(node)) continue
    record?.(t, map.get(t))
    if (isLeaf(after) && after.state === 0) map.delete(t)
    else map.set(t, after)
    changed.push(t)
  }
  return changed
}
