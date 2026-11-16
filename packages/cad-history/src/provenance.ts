// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which step made a face, and which steps used it, from the face keys alone (docs/cad-history.md, "Face keys").
// A face whose key first shows in the parts after step k was made by step k. A base mesh has no keys until the
// first step runs, when the engine gives its faces the base keys (faces.rs base_keys), so those are worked out
// here the way the engine makes them and belong to no step. A step that saved a face's key used that face.
import type { HistoryMesh, Step } from './model'

const MASK = (1n << 64n) - 1n
/** The salt of a history base's keys, faces.rs BASE_SALT. */
const BASE_SALT = 0x5eedba5en

/** faces.rs key(): splitmix64 of the salt, the mesh ordinal and the face, cut to 52 bits and never 0. */
export function engineKey(salt: bigint, ordinal: number, face: number): number {
  let z = (salt ^ ((BigInt(ordinal) * 0x9e3779b97f4a7c15n) & MASK) ^ ((BigInt(face) * 0xbf58476d1ce4e5b9n) & MASK)) & MASK
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK
  z ^= z >> 31n
  return Number(z & ((1n << 52n) - 1n)) || 1
}

/** The keys the base part at `ordinal` gets for its first `faces` faces. */
export function baseKeys(ordinal: number, faces: number): Set<number> {
  const out = new Set<number>()
  for (let i = 0; i < faces; i++) out.add(engineKey(BASE_SALT, ordinal, i))
  return out
}

function keysOf(parts: readonly Pick<HistoryMesh, 'faces'>[]): Set<number> {
  const out = new Set<number>()
  for (const p of parts) for (const k of p.faces?.keys ?? []) if (k > 0) out.add(k)
  return out
}

/**
 * Each face key to the id of the step that made it. `after[k]` is the parts after step k (a replay keeps them),
 * `steps` the history's steps in the same order. Keys of the base are left out: no step made those faces.
 */
export function madeBy(steps: readonly Pick<Step, 'id'>[], after: readonly (readonly Pick<HistoryMesh, 'faces'>[])[]): Map<number, string> {
  const out = new Map<number, string>()
  const seen = new Set<number>()
  // the base's faces come in with the first step, in the base's own part order
  after[0]?.forEach((p, i) => baseKeys(i, p.faces?.table.length ?? 0).forEach((k) => seen.add(k)))
  for (let i = 0; i < steps.length && i < after.length; i++) {
    for (const k of keysOf(after[i]!)) {
      if (seen.has(k)) continue
      seen.add(k)
      out.set(k, steps[i]!.id)
    }
  }
  return out
}

/** Each face key to the ids of the steps that saved it: a push's face, a shell's open faces, a fillet's edge sides. */
export function usedBy(steps: readonly Pick<Step, 'id' | 'params'>[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  const add = (k: number | undefined, id: string) => {
    if (!k) return
    const ids = out.get(k)
    if (!ids) out.set(k, [id])
    else if (!ids.includes(id)) ids.push(id)
  }
  for (const s of steps) {
    const p = s.params
    if (p.op === 'face.push') add(p.faceKey, s.id)
    else if (p.op === 'shell') for (const f of p.open) add(f.key, s.id)
    else if (p.op === 'edge.fillet' || p.op === 'edge.chamfer') for (const e of p.edges) for (const k of e.keys ?? []) add(k, s.id)
  }
  return out
}

/** A plan feature's name as steps and plans are matched by it: case and spacing aside. */
export const featureKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase()

/** The plan features a design's steps build, each once, by the name its first step gives, in build order. */
export function featureNames(steps: readonly Pick<Step, 'feature'>[]): string[] {
  const out = new Map<string, string>()
  for (const s of steps) if (s.feature?.trim() && !out.has(featureKey(s.feature))) out.set(featureKey(s.feature), s.feature.trim())
  return [...out.values()]
}

/**
 * The ids of the steps whose faces are plan feature `feature`'s: the steps tagged with it; the steps a pattern among
 * them repeats (a row or a mirror counts its steps as its first copy); and every pattern that repeats one of those, as
 * a row or a mirror of the feature, untagged or tagged with another name. A pattern's copies are faces the pattern
 * step makes, so a pattern repeating the steps of two features counts for both.
 */
export function featureSteps(steps: readonly Pick<Step, 'id' | 'feature' | 'params'>[], feature: string): Set<string> {
  const key = featureKey(feature)
  const byId = new Map(steps.map((s) => [s.id, s]))
  const out = new Set<string>()
  // down: the tagged steps and, for each pattern reached so, the steps it repeats
  const down = steps.filter((s) => s.feature && featureKey(s.feature) === key).map((s) => s.id)
  while (down.length) {
    const id = down.pop()!
    if (out.has(id)) continue
    out.add(id)
    const p = byId.get(id)?.params
    if (p?.op === 'pattern') down.push(...p.steps.filter((x) => byId.has(x)))
  }
  // up: the patterns that repeat any of them, and the patterns of those
  for (let more = true; more; ) {
    more = false
    for (const s of steps)
      if (!out.has(s.id) && s.params.op === 'pattern' && s.params.steps.some((x) => out.has(x))) {
        out.add(s.id)
        more = true
      }
  }
  return out
}

/** The faces of `part` (ids in its `faces`) that steps `ids` made, by each face's key and `made` (key to step id). */
export function facesMadeBySteps(part: Pick<HistoryMesh, 'faces'>, made: ReadonlyMap<number, string>, ids: ReadonlySet<string>): Set<number> {
  const out = new Set<number>()
  const keys = part.faces?.keys ?? []
  keys.forEach((k, face) => {
    const by = k > 0 ? made.get(k) : undefined
    if (by && ids.has(by)) out.add(face)
  })
  return out
}
