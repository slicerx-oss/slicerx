// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The step that made a picked face, for the crumb in Model's selection pill, and the faces a step made, for its menu.
// A replay of the object's history (warm, so it costs the last step's lookup) gives its faces with their keys and
// the step that made each key.
import type { MeshPart } from '@slicerx/contracts'
import type { PlateEntry } from '../../state/store'
import { keyOfTriangle, type HistoryMesh } from './model'
import { runReplay } from './ops'
import { usedBy } from './provenance'

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

/** What a replay knows of the object's faces, when its parts are the object's own (not one rolled back to edit a step). */
async function knownFor(entry: PlateEntry): Promise<Known | null> {
  let k = known.get(entry.parts)
  if (!k) {
    k = learn(entry).catch(() => null)
    known.set(entry.parts, k)
  }
  const got = await k
  if (!got || got.triangles.length !== entry.parts.length) return null
  return got.triangles.every((n, i) => n === (entry.parts[i]?.indices.length ?? 0) / 3) ? got : null
}

export interface FaceSource {
  /** The step that made the face, or `base` for a face the object started with. */
  made: string
  /** The steps that saved the face to work on it (a push, a shell, a fillet). */
  used: string[]
}

/**
 * Which step made the face of `triangle` on part `part`, and which steps used it. A mesh with no history started
 * with all its faces. Null when that can't be told.
 */
export async function faceSource(entry: PlateEntry, part: number, triangle: number): Promise<FaceSource | null> {
  if (!entry.history?.steps.length) return { made: 'base', used: [] }
  const got = await knownFor(entry)
  const faces = got?.faces[part]
  const key = faces ? keyOfTriangle({ faces }, triangle) : 0
  if (!got || !key) return null
  return { made: got.made[key] ?? 'base', used: usedBy(entry.history.steps).get(key) ?? [] }
}

/** The step id that made a face, or `base`, or null; see faceSource. */
export async function faceMadeBy(entry: PlateEntry, part: number, triangle: number): Promise<string | null> {
  return (await faceSource(entry, part, triangle))?.made ?? null
}

/** One triangle on each face of the result that step `stepId` made. */
export async function facesMadeBy(entry: PlateEntry, stepId: string): Promise<{ partIndex: number; triangle: number }[]> {
  const got = entry.history?.steps.length ? await knownFor(entry) : null
  if (!got) return []
  const out: { partIndex: number; triangle: number }[] = []
  got.faces.forEach((f, partIndex) => {
    if (!f?.keys?.length) return
    const seen = new Set<number>()
    for (let t = 0; t < got.triangles[partIndex]!; t++) {
      const face = f.ids[t] ?? -1
      if (face < 0 || seen.has(face)) continue
      seen.add(face)
      const key = f.keys[face] ?? 0
      if (key && got.made[key] === stepId) out.push({ partIndex, triangle: t })
    }
  })
  return out
}
