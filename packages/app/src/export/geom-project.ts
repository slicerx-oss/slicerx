// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A 3MF project read by the geometry engine's format reader (sx-geom, format.read3mf): objects, their parts with part
// types, slots, settings and paint, and the plates, with each part's mesh in its object's space in millimeters. The
// engine reads the model parts as they inflate, in a worker of its own that ends with the answer, so a big project
// leaves no model text or engine memory behind. import3mf.ts turns it into objects on the plates.
import { geom, soloCall, usesWorker } from '../geom/client'

export type GeomPartKind = 'normal' | 'negative' | 'modifier' | 'support_blocker' | 'support_enforcer'

export interface GeomPart {
  /** The mesh object's id in its model part. */
  id: number
  /** Empty when the file names none. */
  name: string
  meshName: string
  /** The triangles of the mesh object this part is, when the project lists parts by range (PrusaSlicer, older Bambu). */
  range: [number, number] | null
  kind: GeomPartKind
  /** A part type the engine does not know. */
  kindText: string | null
  slot: number | null
  settings: [string, string][]
  /** The paint codes by layer (color, seam, support, fuzzy) in the engine's buffer form; null when nothing is painted. */
  paint: Uint8Array | null
  /** A component placing this mesh in its object names a transform. */
  transformed: boolean
  positions: Float32Array
  indices: Uint32Array
}

export interface GeomObject {
  /** The build item's object id. */
  id: number
  name: string
  /** The build item's transform as 3MF writes it (rows of a 4x3 matrix), in the file's unit. */
  transform: number[]
  printable: boolean
  plate: number | null
  slot: number | null
  settings: [string, string][]
  metadata: [string, string][]
  parts: GeomPart[]
}

export interface GeomProject {
  layout: 'plain' | 'bambu' | 'prusa'
  /** Millimeters per unit of the file. */
  unitScale: number
  /** A model part declares a document type. */
  doctype: boolean
  /** The root model's metadata (title, application, sx: marks). */
  metadata: [string, string][]
  plates: { id: number; name: string; objects: number[]; settings: [string, string][] }[]
  objects: GeomObject[]
  notes: string[]
}

/** Reads the project with the engine. Fails when there is no engine here (no workers, a build without it). */
export async function readWithGeom(bytes: Uint8Array): Promise<GeomProject> {
  // A provider set by a test or a host takes the call as it is.
  if (!usesWorker()) return geom().call<GeomProject>('format.read3mf', { data: { bytes } })
  if (typeof Worker === 'undefined') throw new Error('The geometry engine needs a worker')
  const copy = bytes.slice()
  return soloCall<GeomProject>('format.read3mf', { data: { bytes: copy } }, [copy.buffer]).answer
}

/** A 3MF transform (rows of a 4x3 matrix, in the file's unit) as a column-major 4x4 in millimeters. */
export function geomMatrix(t: number[], unitScale: number): number[] {
  const v = (i: number) => t[i] ?? 0
  return [v(0), v(1), v(2), 0, v(3), v(4), v(5), 0, v(6), v(7), v(8), 0, v(9) * unitScale, v(10) * unitScale, v(11) * unitScale, 1]
}

/** A part's paint buffer as the app keeps paint: each layer's codes by triangle. */
export function geomPaint(b: Uint8Array | null): Partial<Record<'color' | 'seam' | 'support' | 'fuzzy', Record<number, string>>> {
  const out: Partial<Record<'color' | 'seam' | 'support' | 'fuzzy', Record<number, string>>> = {}
  if (!b) return out
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  // One decode for the whole buffer, a character per byte, then each code is a slice of it: paint codes are ASCII,
  // and a decoder call per painted triangle took longer than reading the project.
  const text = new TextDecoder('latin1').decode(b)
  let at = 0
  for (const layer of ['color', 'seam', 'support', 'fuzzy'] as const) {
    const n = view.getUint32(at, true)
    at += 4
    if (!n) continue
    const codes: Record<number, string> = {}
    for (let i = 0; i < n; i++) {
      const t = view.getUint32(at, true)
      const len = view.getUint32(at + 4, true)
      codes[t] = text.slice(at + 8, at + 8 + len)
      at += 8 + len
    }
    out[layer] = codes
  }
  return out
}
