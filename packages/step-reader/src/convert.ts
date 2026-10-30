// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A read STEP file as mesh files and as plain facts: OBJ text with an `o` per object and a `g` per body, a binary STL
// of every body, and the counts and boxes a client reads back. Body colors ride along as data: OBJ vertex colors and
// STL facet colors, written only for bodies that have one, so a file without colors converts exactly as before.
import { boxOf, type StepRead } from './read.ts'

const num = (v: number) => {
  const r = Math.round(v * 1e5) / 1e5
  return Object.is(r, -0) ? '0' : String(r)
}

/** #rrggbb to 0 to 1 channels. */
function channels(color: string): [number, number, number] {
  const n = Number.parseInt(color.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export interface ObjOptions {
  /** Write each colored body's color as OBJ vertex colors (`v x y z r g b`). Default true. */
  colors?: boolean
}

/** The read file as OBJ text: an `o` per object, a `g` per body, in millimeters. */
export function toObj(read: StepRead, opts: ObjOptions = {}): string {
  const colors = opts.colors ?? true
  const out: string[] = []
  let base = 1
  for (const o of read.objects) {
    out.push(`o ${o.name}`)
    for (const b of o.bodies) {
      out.push(`g ${b.name}`)
      const p = b.positions
      const rgb = colors && b.color ? ` ${channels(b.color).map(num).join(' ')}` : ''
      for (let i = 0; i < p.length; i += 3) out.push(`v ${num(p[i]!)} ${num(p[i + 1]!)} ${num(p[i + 2]!)}${rgb}`)
      const t = b.indices
      for (let i = 0; i + 2 < t.length; i += 3) out.push(`f ${t[i]! + base} ${t[i + 1]! + base} ${t[i + 2]! + base}`)
      base += p.length / 3
    }
  }
  return `${out.join('\n')}\n`
}

const STL_HEADER = 'binary STL written from a STEP file'

/** VisCAM and SolidView facet color: 5 bits per channel, blue lowest, bit 15 set when the color is valid. */
function stlColor(color: string): number {
  const [r, g, b] = channels(color).map((c) => Math.round(c * 31))
  return 0x8000 | (r! << 10) | (g! << 5) | b!
}

/** Every body of the read file as one binary STL in millimeters. A colored body's facets carry its color. */
export function toStl(read: StepRead): Uint8Array {
  const bodies = read.objects.flatMap((o) => o.bodies)
  const count = bodies.reduce((n, b) => n + Math.floor(b.indices.length / 3), 0)
  const out = new Uint8Array(84 + count * 50)
  const view = new DataView(out.buffer)
  for (let i = 0; i < STL_HEADER.length; i++) out[i] = STL_HEADER.charCodeAt(i)
  view.setUint32(80, count, true)
  let at = 84
  for (const b of bodies) {
    const p = b.positions
    const t = b.indices
    const attr = b.color ? stlColor(b.color) : 0
    for (let i = 0; i + 2 < t.length; i += 3) {
      const a = t[i]! * 3
      const c = t[i + 1]! * 3
      const d = t[i + 2]! * 3
      const u = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!]
      const v = [p[d]! - p[a]!, p[d + 1]! - p[a + 1]!, p[d + 2]! - p[a + 2]!]
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
      const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
      for (const x of n) {
        view.setFloat32(at, x / len, true)
        at += 4
      }
      for (const k of [a, c, d]) {
        for (let j = 0; j < 3; j++) {
          view.setFloat32(at, p[k + j]!, true)
          at += 4
        }
      }
      view.setUint16(at, attr, true)
      at += 2
    }
  }
  return out
}

/** A box as { min, max } in mm. */
export interface StepBounds {
  min: [number, number, number]
  max: [number, number, number]
}

export interface StepInfo {
  unit: StepRead['unit']
  triangles: number
  toleranceMm: number
  notes: string[]
  bounds: StepBounds | null
  objects: { name: string; triangles: number; bounds: StepBounds | null; bodies: { name: string; color: string | null; triangles: number; bounds: StepBounds | null }[] }[]
}

const round = (v: number) => Math.round(v * 1e4) / 1e4

function bounds(boxes: number[][]): StepBounds | null {
  const finite = boxes.filter((b) => Number.isFinite(b[0]!))
  if (finite.length === 0) return null
  const lo = [0, 1, 2].map((k) => round(Math.min(...finite.map((b) => b[k]!)))) as [number, number, number]
  const hi = [0, 1, 2].map((k) => round(Math.max(...finite.map((b) => b[k + 3]!)))) as [number, number, number]
  return { min: lo, max: hi }
}

/** What a client reads back about a read file: objects, bodies, colors, triangle counts and boxes in mm. */
export function stepInfo(read: StepRead): StepInfo {
  const objects = read.objects.map((o) => {
    const bodies = o.bodies.map((b) => ({ name: b.name, color: b.color ?? null, triangles: Math.floor(b.indices.length / 3), box: boxOf(b.positions) }))
    return {
      name: o.name,
      triangles: bodies.reduce((n, b) => n + b.triangles, 0),
      bounds: bounds(bodies.map((b) => b.box)),
      bodies: bodies.map(({ box, ...b }) => ({ ...b, bounds: bounds([box]) })),
      boxes: bodies.map((b) => b.box),
    }
  })
  return {
    unit: read.unit,
    triangles: read.triangles,
    toleranceMm: read.toleranceMm,
    notes: read.notes,
    bounds: bounds(objects.flatMap((o) => o.boxes)),
    objects: objects.map(({ boxes: _, ...o }) => o),
  }
}
