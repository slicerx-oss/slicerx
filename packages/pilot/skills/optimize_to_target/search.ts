// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The candidate search behind optimize_to_target: a coarse grid over the
// search dimensions, then hill climbing from the best few until the candidate
// budget or the time cap runs out. Evaluation is injected, so tests can run it
// without a slicer.

export type DimValue = number | string

export interface SearchDim {
  key: string
  /** Allowed values in order (small to large for numbers), so neighbors are one step apart. */
  values: DimValue[]
}

export interface Metrics {
  timeS: number
  grams: number
  cost: number
  strength: number
}

export interface Evaluated {
  /** Index into each dimension's values, in dimension order. */
  idx: number[]
  metrics: Metrics
}

export type Objective = 'strength' | 'time' | 'grams' | 'cost'

export interface Target {
  maxTimeS?: number | undefined
  maxGrams?: number | undefined
  maxCost?: number | undefined
  objective: Objective
}

/** How far a result is over the target limits, as a sum of relative overshoots. 0 means it fits. */
export function violation(m: Metrics, t: Target): number {
  let v = 0
  if (t.maxTimeS !== undefined && m.timeS > t.maxTimeS) v += (m.timeS - t.maxTimeS) / t.maxTimeS
  if (t.maxGrams !== undefined && m.grams > t.maxGrams) v += (m.grams - t.maxGrams) / t.maxGrams
  if (t.maxCost !== undefined && m.cost > t.maxCost) v += (m.cost - t.maxCost) / t.maxCost
  return v
}

/** Sort order: results that fit first, best objective first; the rest by how little they overshoot. */
export function compareMetrics(a: Metrics, b: Metrics, t: Target): number {
  const va = violation(a, t)
  const vb = violation(b, t)
  if (va === 0 && vb > 0) return -1
  if (vb === 0 && va > 0) return 1
  if (va > 0 && vb > 0 && Math.abs(va - vb) > 1e-9) return va - vb
  switch (t.objective) {
    case 'strength':
      return b.strength - a.strength || a.timeS - b.timeS
    case 'time':
      return a.timeS - b.timeS || b.strength - a.strength
    case 'grams':
      return a.grams - b.grams || b.strength - a.strength
    case 'cost':
      return a.cost - b.cost || a.timeS - b.timeS
  }
}

/**
 * Layer heights from 25 to 75 percent of the nozzle on a grid of a tenth of
 * the nozzle (0.04 mm steps for a 0.4 mm nozzle), inside the catalog bounds.
 */
export function layerHeights(nozzle: number, bounds?: { min?: number | undefined; max?: number | undefined }): number[] {
  const step = Math.max(0.02, Math.round((nozzle / 10) * 100) / 100)
  const lo = Math.max(nozzle * 0.25, bounds?.min ?? 0)
  const hi = Math.min(nozzle * 0.75, bounds?.max ?? Infinity)
  const out: number[] = []
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) out.push(Math.round(k * step * 1000) / 1000)
  if (out.length === 0) out.push(Math.round(Math.min(hi, Math.max(lo, nozzle / 2)) * 1000) / 1000)
  return out
}

/** Evenly spaced indexes into a list of `n` values, at most `k` of them, always the ends. */
export function spread(n: number, k: number): number[] {
  if (n <= k) return Array.from({ length: n }, (_, i) => i)
  if (k <= 1) return [Math.floor(n / 2)]
  const out = new Set<number>()
  for (let i = 0; i < k; i++) out.add(Math.round((i * (n - 1)) / (k - 1)))
  return [...out]
}

/** Small deterministic generator (mulberry32) so the subsample is the same run to run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SearchOptions {
  dims: SearchDim[]
  target: Target
  maxCandidates: number
  /** True when the time cap has run out or the run was canceled. */
  stop(): boolean
  /** Slices one candidate. Null when it failed; the search moves on. */
  evaluate(values: DimValue[], idx: number[]): Promise<Metrics | null>
  onProgress?(done: number, phase: 'coarse' | 'refine'): void
  /** Values per dimension in the coarse grid (default 3). */
  coarsePerDim?: number
  /** Start points kept for each refine round (default 4). */
  beam?: number
}

export interface SearchResult {
  evaluated: Evaluated[]
  coarse: number
  refined: number
  stoppedBy: 'budget' | 'time' | 'converged'
}

/**
 * Coarse grid, then refine. The coarse grid takes up to three evenly spread
 * values per dimension (all of them for short lists) and uses at most 45
 * percent of the budget, subsampled at random with a fixed seed when larger.
 * Each refine round moves the best few one step along every dimension, and
 * one step up and down along each pair of ordered dimensions; it stops when a
 * round finds nothing new, the budget is spent or time is up.
 */
export async function searchSpace(o: SearchOptions): Promise<SearchResult> {
  const seen = new Map<string, Evaluated | null>()
  const evaluated: Evaluated[] = []
  let stoppedBy: SearchResult['stoppedBy'] = 'converged'
  // A function, so the checks after each await are not narrowed away.
  const halted = (): boolean => stoppedBy !== 'converged'
  const run = async (idx: number[], phase: 'coarse' | 'refine'): Promise<boolean> => {
    const key = idx.join(',')
    if (seen.has(key)) return false
    if (seen.size >= o.maxCandidates) {
      stoppedBy = 'budget'
      return false
    }
    if (o.stop()) {
      stoppedBy = 'time'
      return false
    }
    const values = idx.map((i, d) => o.dims[d]?.values[i] ?? '')
    const m = await o.evaluate(values, idx)
    const e = m ? { idx, metrics: m } : null
    seen.set(key, e)
    if (e) evaluated.push(e)
    o.onProgress?.(seen.size, phase)
    return true
  }

  // Coarse grid.
  const per = o.coarsePerDim ?? 3
  const axes = o.dims.map((d) => (d.key === 'orientation' || typeof d.values[0] === 'string' ? spread(d.values.length, Math.max(per, 6)) : spread(d.values.length, per)))
  let grid: number[][] = [[]]
  for (const a of axes) grid = grid.flatMap((g) => a.map((i) => [...g, i]))
  const cap = Math.max(1, Math.floor(o.maxCandidates * 0.45))
  if (grid.length > cap) {
    const r = rng(7)
    for (let i = grid.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1))
      const tmp = grid[i] ?? []
      grid[i] = grid[j] ?? []
      grid[j] = tmp
    }
    grid = grid.slice(0, cap)
  }
  for (const g of grid) {
    await run(g, 'coarse')
    if (halted()) break
  }
  const coarse = seen.size

  // Refine around the best.
  const beam = o.beam ?? 4
  const ordered = (d: number): boolean => o.dims[d]?.key !== 'orientation' && typeof o.dims[d]?.values[0] === 'number'
  while (!halted()) {
    const best = [...evaluated].sort((a, b) => compareMetrics(a.metrics, b.metrics, o.target)).slice(0, beam)
    let fresh = 0
    for (const b of best) {
      for (let d = 0; d < o.dims.length; d++) {
        const n = o.dims[d]?.values.length ?? 0
        const moves = typeof o.dims[d]?.values[0] === 'string' || o.dims[d]?.key === 'orientation' ? Array.from({ length: n }, (_, i) => i) : [(b.idx[d] ?? 0) - 1, (b.idx[d] ?? 0) + 1]
        for (const i of moves) {
          if (i < 0 || i >= n || i === b.idx[d]) continue
          const next = [...b.idx]
          next[d] = i
          if (await run(next, 'refine')) fresh++
          if (halted()) break
        }
        if (halted()) break
      }
      // Trade moves: one step up in one ordered dimension and one step down in
      // another, such as one more wall for a little less infill, which walks
      // along a time or weight limit where single steps stall.
      for (let d1 = 0; d1 < o.dims.length && !halted(); d1++) {
        if (!ordered(d1)) continue
        for (let d2 = d1 + 1; d2 < o.dims.length && !halted(); d2++) {
          if (!ordered(d2)) continue
          for (const [s1, s2] of [[1, -1], [-1, 1]] as const) {
            const next = [...b.idx]
            const i1 = (b.idx[d1] ?? 0) + s1
            const i2 = (b.idx[d2] ?? 0) + s2
            if (i1 < 0 || i2 < 0 || i1 >= (o.dims[d1]?.values.length ?? 0) || i2 >= (o.dims[d2]?.values.length ?? 0)) continue
            next[d1] = i1
            next[d2] = i2
            if (await run(next, 'refine')) fresh++
            if (halted()) break
          }
        }
      }
      if (halted()) break
    }
    if (fresh === 0) break
  }
  evaluated.sort((a, b) => compareMetrics(a.metrics, b.metrics, o.target))
  return { evaluated, coarse, refined: seen.size - coarse, stoppedBy }
}
