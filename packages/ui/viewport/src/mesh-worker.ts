// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The worker side of mesh building (mesh-pool.ts): a big part's creased normals or feature edges, made off the page's
// main thread. The viewport stays free of worker plumbing; an app makes the worker from a two-line module of its own:
//
//   import { serveMeshBuilds } from '@slicerx/viewport/mesh-worker'
//   serveMeshBuilds(self)
//
// and hands the viewport a factory for it (ViewportOptions.meshWorker).
import { creasedArrays, featureEdges, type CreasedArrays } from './mesh-math'

/** One job: the creased geometry or the feature edges of a part, with the angle that decides them. */
export interface MeshBuildRequest {
  id: number
  kind: 'crease' | 'edges'
  positions: Float32Array
  indices: Uint32Array | Uint16Array
  deg: number
}

export type MeshBuildReply =
  | { id: number; ok: true; crease?: CreasedArrays; edges?: Float32Array }
  | { id: number; ok: false; error: string }

/** Does one job, and lists the result's buffers so they move to the page instead of being copied. */
export function answerMeshBuild(req: MeshBuildRequest): { reply: MeshBuildReply; transfer: ArrayBuffer[] } {
  try {
    if (req.kind === 'crease') {
      const crease = creasedArrays(req.positions, req.indices, req.deg)
      return { reply: { id: req.id, ok: true, crease }, transfer: [crease.position.buffer, crease.normal.buffer, crease.index.buffer] as ArrayBuffer[] }
    }
    const edges = featureEdges(req.positions, req.indices, req.deg)
    return { reply: { id: req.id, ok: true, edges }, transfer: [edges.buffer as ArrayBuffer] }
  } catch (e) {
    return { reply: { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }, transfer: [] }
  }
}

/** The worker global, as much of it as this needs. */
export interface MeshWorkerScope {
  onmessage: ((e: MessageEvent<MeshBuildRequest>) => void) | null
  postMessage(message: MeshBuildReply, transfer: Transferable[]): void
}

/** Answers every job sent to this worker. */
export function serveMeshBuilds(scope: MeshWorkerScope): void {
  scope.onmessage = (e) => {
    const { reply, transfer } = answerMeshBuild(e.data)
    scope.postMessage(reply, transfer)
  }
}
