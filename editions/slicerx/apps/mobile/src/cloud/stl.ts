// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Just enough STL reading for the phone to show a model's size before it goes
// to the cloud, which does the real parsing. Files are untrusted: every read
// is bounds checked and a file that does not parse gets a default size.

export interface MeshBounds {
  triangles: number
  /** Axis-aligned size in mm, Z up. */
  sizeMm: [number, number, number]
  /** False when the file was not an STL we could read, so the size is a guess. */
  measured: boolean
}

const FALLBACK: MeshBounds = { triangles: 0, sizeMm: [40, 40, 30], measured: false }
const MAX_TRIANGLES = 5_000_000

function boundsOf(points: Iterable<[number, number, number]>, triangles: number): MeshBounds {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let any = false
  for (const p of points) {
    for (let a = 0; a < 3; a++) {
      const v = p[a as 0 | 1 | 2]
      if (!Number.isFinite(v)) continue
      any = true
      if (v < (min[a] ?? v)) min[a] = v
      if (v > (max[a] ?? v)) max[a] = v
    }
  }
  if (!any) return FALLBACK
  const size = [0, 1, 2].map((a) => Math.round(((max[a] ?? 0) - (min[a] ?? 0)) * 100) / 100) as [number, number, number]
  return { triangles, sizeMm: size, measured: true }
}

function* binaryPoints(view: DataView, count: number): Generator<[number, number, number]> {
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12
    for (let v = 0; v < 3; v++) {
      const o = base + v * 12
      yield [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)]
    }
  }
}

function* asciiPoints(text: string): Generator<[number, number, number]> {
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g
  for (let m = re.exec(text); m; m = re.exec(text)) yield [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Size and triangle count of a binary or ASCII STL. Other formats return a default size. */
export function meshBounds(data: ArrayBuffer): MeshBounds {
  if (data.byteLength >= 84) {
    const view = new DataView(data)
    const count = view.getUint32(80, true)
    if (count > 0 && count <= MAX_TRIANGLES && 84 + count * 50 === data.byteLength) return boundsOf(binaryPoints(view, count), count)
  }
  const head = new TextDecoder().decode(data.slice(0, Math.min(data.byteLength, 512)))
  if (/^\s*solid\b/.test(head) && data.byteLength < 64 * 1024 * 1024) {
    const text = new TextDecoder().decode(data)
    const b = boundsOf(asciiPoints(text), (text.match(/facet\s+normal/g) ?? []).length)
    return b
  }
  return FALLBACK
}

/**
 * A binary STL box of the given size. Library models are fetched by the cloud
 * from the store, so the phone only sends a stand-in with the listing's size
 * when it runs against the local stub.
 */
export function boxStl(sizeMm: [number, number, number]): ArrayBuffer {
  const [x, y, z] = sizeMm
  const v: [number, number, number][] = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
  ]
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  const buf = new ArrayBuffer(84 + faces.length * 50)
  const view = new DataView(buf)
  view.setUint32(80, faces.length, true)
  faces.forEach((f, i) => {
    const o = 84 + i * 50 + 12
    f.forEach((vi, k) => {
      const p = v[vi] ?? [0, 0, 0]
      view.setFloat32(o + k * 12, p[0], true)
      view.setFloat32(o + k * 12 + 4, p[1], true)
      view.setFloat32(o + k * 12 + 8, p[2], true)
    })
  })
  return buf
}
