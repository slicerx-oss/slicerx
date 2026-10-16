// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The step that made a picked face, for the crumb in Model's selection pill, and the faces a step made, for its menu.
// A replay of the object's history (warm, so it costs the last step's lookup) gives its faces with their keys and
// the step that made each key.
import type { MeshPart } from '@slicerx/contracts'
import type { PlateEntry } from '../../state/store'
import { keyOfTriangle, point, usedBy, type HistoryMesh, type Step, type StepStatus } from '@slicerx/cad-history'
import { runReplay, withStatus } from './ops'

type Faces = HistoryMesh['faces']
interface Known {
  faces: Faces[]
  triangles: number[]
  made: Record<number, string>
  /** The steps with the face keys the replay found for them: a pull made on a mesh with no keys yet has none saved. */
  steps: Step[]
}

// By the parts a replay put on the object: a new result is a new array, so a stale answer is never read.
const known = new WeakMap<readonly MeshPart[], Promise<Known | null>>()

async function learn(entry: PlateEntry): Promise<Known | null> {
  const r = await runReplay({ history: entry.history! })
  if (!r.madeBy) return null
  const steps = withStatus(entry.history!.steps, r.status, r.found).map((s, i) => withCapKey(s, r.status[i], r.parts))
  return { faces: r.parts.map((p) => p.faces), triangles: r.parts.map((p) => p.indices.length / 3), made: r.madeBy, steps }
}

/**
 * A pull on a part with no face keys yet (a fresh box) saves no key: the engine gives the base its keys inside the
 * call, and the moved cap keeps the key of the face it was. So the face a keyless pull used is the one face of the
 * result that lies on its cap's plane, facing its way. Read here only, never saved: a replay finds a saved key on
 * the part before the step, and a keyless base has none to find.
 */
function withCapKey(s: Step, status: StepStatus | undefined, parts: readonly HistoryMesh[]): Step {
  const p = s.params
  if (p.op !== 'face.push' || p.faceKey || s.suppressed || status?.state !== 'done') return s
  const part = parts[s.part]
  const f = part?.faces
  if (!part || !f?.keys?.length) return s
  const l = Math.hypot(...p.normal) || 1
  const n = [p.normal[0] / l, p.normal[1] / l, p.normal[2] / l] as const
  const cap = [p.at[0] + n[0] * p.distanceMm, p.at[1] + n[1] * p.distanceMm, p.at[2] + n[2] * p.distanceMm] as const
  const keys = new Set<number>()
  const ix = part.indices
  for (let t = 0; 3 * t + 2 < ix.length; t++) {
    const [a, b, c] = [0, 1, 2].map((j) => point(s.transform, part.positions, 3 * ix[3 * t + j]!))
    const cr = [(b![1] - a![1]) * (c![2] - a![2]) - (b![2] - a![2]) * (c![1] - a![1]), (b![2] - a![2]) * (c![0] - a![0]) - (b![0] - a![0]) * (c![2] - a![2]), (b![0] - a![0]) * (c![1] - a![1]) - (b![1] - a![1]) * (c![0] - a![0])]
    const area2 = Math.hypot(cr[0]!, cr[1]!, cr[2]!)
    if (area2 < 1e-12 || (cr[0]! * n[0] + cr[1]! * n[1] + cr[2]! * n[2]) / area2 < 0.99999) continue
    if (Math.abs((a![0] - cap[0]) * n[0] + (a![1] - cap[1]) * n[1] + (a![2] - cap[2]) * n[2]) > 0.01) continue
    const k = keyOfTriangle(part, t)
    if (k) keys.add(k)
  }
  // two faces on that plane leave the pull's own one untold
  if (keys.size !== 1) return s
  return { ...s, params: { ...p, faceKey: [...keys][0]! } }
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

/**
 * A pull keeps the key of the face it moves, so a moved cap is still the base's face by key. For what the person sees,
 * the pull that moved it is its maker: the last live push among the steps that used the face, or undefined.
 */
export function movedBy(steps: readonly Step[], used: readonly string[]): string | undefined {
  return used.findLast((id) => steps.some((s) => s.id === id && !s.suppressed && s.params.op === 'face.push'))
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
  return { made: got.made[key] ?? 'base', used: usedBy(got.steps).get(key) ?? [] }
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
      if (!key) continue
      const maker = got.made[key] ?? movedBy(got.steps, usedBy(got.steps).get(key) ?? [])
      if (maker === stepId) out.push({ partIndex, triangle: t })
    }
  })
  return out
}
