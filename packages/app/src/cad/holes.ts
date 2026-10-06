// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the hole and thread tools do to the plate, with no React: the hole made to its new spec, or the thread cut,
// in one store update, as a step of the object's history.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { holeApply, threadApply, type MeshItem } from '../geom/cad'
import { fromGeom, toGeom, type GeomMesh } from '../geom/client'
import { get, markStale, set } from '../state/store'
import type { StepParams } from './history/model'
import { withStep } from './history/record'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

export type HoleParams = Extract<StepParams, { op: 'hole.apply' }>

export type ThreadParams = Extract<StepParams, { op: 'thread.apply' }>

export function applyHole(host: Loader, objectId: string, partIndex: number, params: HoleParams): Promise<{ message: string; warn: boolean }> {
  return applyPartStep(host, objectId, partIndex, params, (mesh) => holeApply(mesh, params.hole, params.spec))
}

export function applyThread(host: Loader, objectId: string, partIndex: number, params: ThreadParams): Promise<{ message: string; warn: boolean }> {
  return applyPartStep(host, objectId, partIndex, params, (mesh) => threadApply(mesh, params.thread, params.spec))
}

async function applyPartStep(
  host: Loader,
  objectId: string,
  partIndex: number,
  params: HoleParams | ThreadParams,
  run: (mesh: MeshItem) => Promise<{ mesh: GeomMesh; watertight: boolean }>,
): Promise<{ message: string; warn: boolean }> {
  const e = get().plate.find((p) => p.id === objectId)
  const part = e?.parts[partIndex]
  if (!e || !part) throw new Error('That object is gone.')
  const r = await run({ mesh: toGeom(part), transform: e.transform })
  const parts = e.parts.map((p, i) => (i === partIndex ? fromGeom(r.mesh, p.name, p.slot) : p))
  const handle = await host.loadParts(e.name, parts)
  const { instanceOf: _was, paint: _paint, ...rest } = e
  const history = withStep(e, partIndex, params)
  set({ plate: get().plate.map((p) => (p.id === e.id ? { ...rest, handle, parts, history } : p)) })
  markStale()
  return { message: `${params.label} in ${e.name}.`, warn: !r.watertight }
}
