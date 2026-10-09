// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The step that made a picked face, for the crumb in Model's selection pill. A replay of the object's history (warm,
// so it costs the last step's lookup) gives its faces with their keys and the step that made each key.
import type { MeshPart } from '@slicerx/contracts'
import type { PlateEntry } from '../../state/store'
import { keyOfTriangle, type HistoryMesh } from './model'
import { runReplay } from './ops'

type Faces = HistoryMesh['faces']
interface Known {
  faces: Faces[]
  triangles: number[]
  made: Record<number, string>
}

// By the parts a replay put on the object: a new result is a new array, so a stale answer is never read.
const known = new WeakMap<readonly MeshPart[], Promise<Known | null>>()

async function learn(entry: PlateEntry): Promise<Known | null> {
  const r = await runReplay({ history: entry.history! })
  if (!r.madeBy) return null
  return { faces: r.parts.map((p) => p.faces), triangles: r.parts.map((p) => p.indices.length / 3), made: r.madeBy }
}

/**
 * Which step made the face of `triangle` on part `part`: its step id, `base` for a face the object started with
 * (an imported mesh, or a shape no step has changed there), or null when that can't be told.
 */
export async function faceMadeBy(entry: PlateEntry, part: number, triangle: number): Promise<string | null> {
  if (!entry.history?.steps.length) return 'base'
  let k = known.get(entry.parts)
  if (!k) {
    k = learn(entry).catch(() => null)
    known.set(entry.parts, k)
  }
  const got = await k
  // the replay's parts are the object's own; any other mesh (one rolled back to edit a step) gets no answer
  if (!got || got.triangles[part] !== (entry.parts[part]?.indices.length ?? 0) / 3) return null
  const faces = got.faces[part]
  const key = faces ? keyOfTriangle({ faces }, triangle) : 0
  if (!key) return null
  return got.made[key] ?? 'base'
}
