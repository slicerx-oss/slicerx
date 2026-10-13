// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// CAD history in a project file (docs/cad-history.md, "Storage"): Metadata/slicerx_history.json with
// the steps, and one binary part per stored mesh set (an object's base, the parts a merge added) under
// Metadata/slicerx_history/. Both are optional parts other slicers ignore; the model part keeps the
// current mesh, so the file prints the same anywhere. Reading is in read.ts, loaded with the
// project reader.
// Version 2 names faces by key (docs/cad-history.md, "Face keys"); version 1 files still open.
// Version 3 is one design timeline for the plate (design.ts); versions 1 and 2 open as one.
export const HISTORY_FILE_VERSION = 2
export const DESIGN_FILE_VERSION = 3
import type { Timeline } from './design'
import type { History, HistoryMesh, PaintTexts, PrimitiveSpec } from './model'

/** A part of the project's zip, as the app's writer takes it. */
export interface ZipEntry {
  name: string
  data: Uint8Array | string
}

export const MAGIC = 0x4d485853 // "SXHM" little endian
export const BIN_VERSION = 1

/** Meshes as one binary part: magic, version, count, then per mesh vertex count, triangle count, float32 positions, uint32 indices. */
export function encodeMeshes(meshes: readonly HistoryMesh[]): Uint8Array {
  let size = 12
  for (const m of meshes) size += 8 + m.positions.length * 4 + m.indices.length * 4
  const buf = new ArrayBuffer(size)
  const dv = new DataView(buf)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, BIN_VERSION, true)
  dv.setUint32(8, meshes.length, true)
  let at = 12
  for (const m of meshes) {
    dv.setUint32(at, m.positions.length / 3, true)
    dv.setUint32(at + 4, m.indices.length / 3, true)
    at += 8
    for (let i = 0; i < m.positions.length; i++, at += 4) dv.setFloat32(at, m.positions[i]!, true)
    for (let i = 0; i < m.indices.length; i++, at += 4) dv.setUint32(at, m.indices[i]!, true)
  }
  return new Uint8Array(buf)
}

interface StoredMeshes {
  file: string
  parts: { name: string; slot: number; paint?: PaintTexts; primitive?: PrimitiveSpec }[]
}

/** Stores mesh sets as binary parts named after the object: <id>-0.bin, <id>-1.bin and on. */
function storer(files: ZipEntry[], id: number): (meshes: readonly HistoryMesh[]) => StoredMeshes {
  let n = 0
  return (meshes) => {
    const file = `Metadata/slicerx_history/${id}-${n++}.bin`
    files.push({ name: file, data: encodeMeshes(meshes) })
    // Paint and the shape a part was made as ride in the JSON with each part's name and slot; the binary meshes stay
    // positions and indices.
    return { file, parts: meshes.map((m) => ({ name: m.name, slot: m.slot, ...(m.paint && Object.keys(m.paint).length ? { paint: m.paint } : {}), ...(m.primitive ? { primitive: m.primitive } : {}) })) }
  }
}

/**
 * The history parts of a project: the JSON and the binary meshes, for every written object that has
 * a history. Empty when none has one, so nothing is added.
 */
export function historyFiles(objects: readonly { id: string; history?: History; instanceOf?: string }[], fileIds: ReadonlyMap<string, number>): ZipEntry[] {
  const files: ZipEntry[] = []
  const out: unknown[] = []
  for (const o of objects) {
    const h = o.history
    const id = fileIds.get(o.id)
    // A copy shares its source's mesh and history; the history is stored once, with the source.
    if (!h || id === undefined || (o.instanceOf && objects.some((x) => x.id === o.instanceOf))) continue
    const store = storer(files, id)
    const base = h.base.length ? store(h.base) : null
    const steps = h.steps.map((s) => (s.params.op === 'parts.add' ? { ...s, params: { ...s.params, parts: store(s.params.parts) } } : s))
    out.push({ object: String(id), base, ...(h.ended ? { ended: h.ended } : {}), steps })
  }
  if (!out.length) return []
  return [{ name: 'Metadata/slicerx_history.json', data: JSON.stringify({ version: HISTORY_FILE_VERSION, objects: out }) }, ...files]
}

/**
 * The design's parts of a project (version 3): bodies by 3MF object id with their base meshes, then the timeline.
 * A body whose object is not written (a copy, or gone) is left out with its features. Empty when nothing is left.
 */
export function timelineFiles(d: Timeline, fileIds: ReadonlyMap<string, number>): ZipEntry[] {
  const files: ZipEntry[] = []
  const stores = new Map<string, (meshes: readonly HistoryMesh[]) => StoredMeshes>()
  const bodies: unknown[] = []
  for (const b of d.bodies) {
    const id = fileIds.get(b.id)
    if (id === undefined) continue
    const store = storer(files, id)
    stores.set(b.id, store)
    bodies.push({ object: String(id), base: b.base.length ? store(b.base) : null, ...(b.ended ? { ended: b.ended } : {}) })
  }
  if (!bodies.length) return []
  const items: unknown[] = []
  let marker = 0
  d.items.forEach((it, i) => {
    if (it.kind === 'feature') {
      const store = stores.get(it.body)
      if (!store) return
      const p = it.params
      items.push({ ...it, body: String(fileIds.get(it.body)), ...(p.op === 'parts.add' ? { params: { ...p, parts: store(p.parts) } } : {}) })
    } else if (it.on) {
      // a sketch keeps the body it sits on only while that body is saved
      const { on, ...k } = it
      items.push(fileIds.has(on.body) ? { ...it, on: { ...on, body: String(fileIds.get(on.body)) } } : k)
    } else items.push(it)
    if (i < d.marker) marker = items.length
  })
  return [{ name: 'Metadata/slicerx_history.json', data: JSON.stringify({ version: DESIGN_FILE_VERSION, bodies, items, marker }) }, ...files]
}
