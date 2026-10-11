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
  paint: Record<'color' | 'seam' | 'support' | 'fuzzy', [number, string][]>
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
