// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// CAD history in a project file (docs/cad-history.md, "Storage"): Metadata/slicerx_history.json with
// the steps, and one binary part per stored mesh set (an object's base, the parts a merge added) under
// Metadata/slicerx_history/. Both are optional parts other slicers ignore; the model part keeps the
// current mesh, so the file prints the same anywhere. Reading is in history-read.ts, loaded with the
// project reader.
// Version 2 names faces by key (docs/cad-history.md, "Face keys"); version 1 files still open.
export const HISTORY_FILE_VERSION = 2
import type { History, HistoryMesh } from '../cad/history/model'
import type { ZipEntry } from './zip'

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
  parts: { name: string; slot: number }[]
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
    let n = 0
    const store = (meshes: readonly HistoryMesh[]): StoredMeshes => {
      const file = `Metadata/slicerx_history/${id}-${n++}.bin`
      files.push({ name: file, data: encodeMeshes(meshes) })
      return { file, parts: meshes.map((m) => ({ name: m.name, slot: m.slot })) }
    }
    const base = h.base.length ? store(h.base) : null
    const steps = h.steps.map((s) => (s.params.op === 'parts.add' ? { ...s, params: { ...s.params, parts: store(s.params.parts) } } : s))
    out.push({ object: String(id), base, ...(h.ended ? { ended: h.ended } : {}), steps })
  }
  if (!out.length) return []
  return [{ name: 'Metadata/slicerx_history.json', data: JSON.stringify({ version: HISTORY_FILE_VERSION, objects: out }) }, ...files]
}
