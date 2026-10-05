// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plain mesh export: the selected objects or the whole plate as binary STL or OBJ, in plate coordinates
// (millimeters, Z up, transforms applied). Projects stay .sx3mf; this is for handing a model to another tool.
import type { Host, MeshPart } from '@slicerx/contracts'
import { apply, type Vec3 } from '../plate/transform'
import { get, selectedIds, toast, type PlateEntry } from '../state/store'
import { appName } from '../edition'

export type MeshFormat = 'stl' | 'obj'
export type MeshScope = 'selection' | 'plate'

interface World {
  name: string
  positions: Float32Array
  indices: Uint32Array
}

/** Every part of the object (and its printable volumes) as world-space triangles. Negative volumes and blockers are not geometry. */
function worldParts(e: PlateEntry): World[] {
  return e.parts.map((p: MeshPart) => {
    const out = new Float32Array(p.positions.length)
    for (let i = 0; i + 2 < p.positions.length; i += 3) {
      const w = apply(e.transform, [p.positions[i] ?? 0, p.positions[i + 1] ?? 0, p.positions[i + 2] ?? 0])
      out[i] = w[0]
      out[i + 1] = w[1]
      out[i + 2] = w[2]
    }
    // A mirrored object turns its triangles inside out; the winding is flipped back.
    const m = e.transform
    const det = (m[0] ?? 0) * ((m[5] ?? 0) * (m[10] ?? 0) - (m[6] ?? 0) * (m[9] ?? 0)) - (m[4] ?? 0) * ((m[1] ?? 0) * (m[10] ?? 0) - (m[2] ?? 0) * (m[9] ?? 0)) + (m[8] ?? 0) * ((m[1] ?? 0) * (m[6] ?? 0) - (m[2] ?? 0) * (m[5] ?? 0))
    let idx = p.indices
    if (det < 0) {
      idx = new Uint32Array(p.indices)
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const t = idx[i + 1]!
        idx[i + 1] = idx[i + 2]!
        idx[i + 2] = t
      }
    }
    return { name: p.name, positions: out, indices: idx }
  })
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

function normal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const u = sub(b, a)
  const v = sub(c, a)
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const l = Math.hypot(n[0], n[1], n[2]) || 1
  return [n[0] / l, n[1] / l, n[2] / l]
}

const vert = (p: Float32Array, i: number): Vec3 => [p[i * 3] ?? 0, p[i * 3 + 1] ?? 0, p[i * 3 + 2] ?? 0]

export function binaryStl(parts: readonly World[], title = appName()): Uint8Array {
  const tris = parts.reduce((n, p) => n + Math.floor(p.indices.length / 3), 0)
  const buf = new ArrayBuffer(84 + tris * 50)
  const dv = new DataView(buf)
  new Uint8Array(buf).set(new TextEncoder().encode(title.slice(0, 79)))
  dv.setUint32(80, tris, true)
  let o = 84
  for (const p of parts) {
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      const a = vert(p.positions, p.indices[t]!)
      const b = vert(p.positions, p.indices[t + 1]!)
      const c = vert(p.positions, p.indices[t + 2]!)
      for (const v of [normal(a, b, c), a, b, c]) for (const x of v) {
        dv.setFloat32(o, x, true)
        o += 4
      }
      o += 2
    }
  }
  return new Uint8Array(buf)
}

export function wavefrontObj(objects: readonly { name: string; parts: readonly World[] }[]): string {
  const lines = [`# ${appName()} export, millimeters, Z up`]
  let base = 1
  for (const o of objects) {
    lines.push(`o ${o.name.replace(/\s+/g, '_')}`)
    for (const p of o.parts) {
      for (let i = 0; i + 2 < p.positions.length; i += 3) lines.push(`v ${p.positions[i]!.toFixed(5)} ${p.positions[i + 1]!.toFixed(5)} ${p.positions[i + 2]!.toFixed(5)}`)
      for (let t = 0; t + 2 < p.indices.length; t += 3) lines.push(`f ${p.indices[t]! + base} ${p.indices[t + 1]! + base} ${p.indices[t + 2]! + base}`)
      base += p.positions.length / 3
    }
  }
  return `${lines.join('\n')}\n`
}

/** The objects a scope names: the selection (all selected objects) or every printable object on the plate. */
export function exportTargets(scope: MeshScope): PlateEntry[] {
  const { plate } = get()
  const ids = new Set(selectedIds())
  return plate.filter((p) => p.printable !== false && (scope === 'plate' || ids.has(p.id)))
}

export function meshExportBytes(objects: readonly PlateEntry[], format: MeshFormat): Uint8Array {
  if (format === 'stl') return binaryStl(objects.flatMap(worldParts))
  return new TextEncoder().encode(wavefrontObj(objects.map((o) => ({ name: o.name, parts: worldParts(o) }))))
}

/** Saves the selection or the plate as an STL or OBJ file. Returns false when there is nothing to save or the person canceled. */
export async function exportMesh(host: Host, scope: MeshScope, format: MeshFormat): Promise<boolean> {
  const objects = exportTargets(scope)
  if (objects.length === 0) {
    toast(scope === 'selection' ? 'Select an object to export.' : 'There is nothing on the plate to export.', 'info')
    return false
  }
  const bytes = meshExportBytes(objects, format)
  const base = objects.length === 1 ? objects[0]!.name : 'plate'
  const name = `${base.replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '_') || 'plate'}.${format}`
  const ref = await host.files.save(name, new Blob([bytes as BlobPart], { type: format === 'stl' ? 'model/stl' : 'model/obj' }), { accept: [`.${format}`] })
  if (ref) toast(`Saved ${ref.name}`, 'ok')
  return ref !== null
}
