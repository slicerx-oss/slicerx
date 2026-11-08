// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How long fitFacts takes on a finely meshed design: 8 gaps, each between two faces drawn in about 40,000 level
// facets. The engine's report is stubbed, so this times only the facet work done for every gap.
import type { Design as HostDesign, DesignHost, HistoryMesh } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { fitFacts, fitLimits } from '../src/fit-facts'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const designOf = (parts: HistoryMesh[]) => ({ id: 'd', name: 'Chain', history: { version: 1, base: [], steps: [] }, transform: IDENTITY, parts, status: [], madeBy: {}, redo: [] }) as unknown as HostDesign

/** A square grid of `cells` by `cells` cells (two facets each), `sizeMm` across, at height z, facing up or down. */
function grid(positions: number[], indices: number[], cells: number, sizeMm: number, z: number, up: boolean): void {
  const base = positions.length / 3
  for (let j = 0; j <= cells; j++) for (let i = 0; i <= cells; i++) positions.push((sizeMm * i) / cells, (sizeMm * j) / cells, z)
  for (let j = 0; j < cells; j++)
    for (let i = 0; i < cells; i++) {
      const [a, b, c, d] = [base + j * (cells + 1) + i, base + j * (cells + 1) + i + 1, base + (j + 1) * (cells + 1) + i + 1, base + (j + 1) * (cells + 1) + i]
      indices.push(...(up ? [a, b, c, a, c, d] : [a, c, b, a, d, c]))
    }
}

/** 9 slabs stacked with 0.4 mm between each top and the bottom above it: 8 gaps, every face a dense grid of level facets. */
function chain(cells: number, sizeMm: number, at: [number, number]) {
  const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2, material: 'PLA' })
  const parts: HistoryMesh[] = []
  for (let k = 0; k < 9; k++) {
    const positions: number[] = []
    const indices: number[] = []
    grid(positions, indices, cells, sizeMm, 5.4 * k, false)
    grid(positions, indices, cells, sizeMm, 5.4 * k + 5, true)
    parts.push({ name: `Slab ${k + 1}`, slot: 0, positions, indices })
  }
  const report = {
    parts: parts.map((_, k) => ({ bounds: { min: [0, 0, 5.4 * k], max: [sizeMm, sizeMm, 5.4 * k + 5] }, item: k })),
    gaps: Array.from({ length: 8 }, (_, k) => ({ parts: [k, k + 1], gapMm: 0.4, limitMm: limits.verticalMm, kind: 'apart', from: [...at, 5.4 * k + 5], to: [...at, 5.4 * (k + 1)] })),
    pieces: 9,
  }
  return { limits, parts, report }
}

/** One pass over every facet of the design reading its corners, the least any facet rule has to do. */
function scan(parts: HistoryMesh[]): number {
  let sum = 0
  for (const m of parts)
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
      sum += Math.hypot(m.positions[j * 3]! - m.positions[i * 3]!, m.positions[k * 3 + 1]! - m.positions[i * 3 + 1]!, m.positions[k * 3 + 2]! - m.positions[i * 3 + 2]!)
    }
  return sum
}

const time = <T>(f: () => T): number => {
  const t0 = performance.now()
  f()
  return performance.now() - t0
}

describe('fitFacts on a finely meshed design', () => {
  for (const [what, at] of [['the middle of the faces', [7, 7]], ['a corner of the faces', [0, 0]]] as const)
  it(`8 gaps from ${what}, between faces of about 40,000 level facets each stay within a fixed multiple of one pass over the facets`, async () => {
    const { limits, parts, report } = chain(140, 14, at)
    const host = { call: async () => report } as unknown as DesignHost
    const d = designOf(parts)
    const facets = parts.reduce((n, m) => n + m.indices.length / 3, 0)
    expect(facets).toBeGreaterThan(9 * 2 * 39000)
    // the best of a few runs of each, so one slow moment does not decide it. Measured on a laptop: a pass is 13 to 16 ms
    // and fitFacts 195 to 570 ms (best of three 195 to 350), at most about 25 times a pass; the bound is 6 times that
    const scanMs = Math.min(...[0, 1, 2].map(() => time(() => scan(parts))))
    let fit: Awaited<ReturnType<typeof fitFacts>> | undefined
    const runs: number[] = []
    for (let n = 0; n < 3; n++) {
      const t0 = performance.now()
      fit = await fitFacts(host, d, limits)
      runs.push(performance.now() - t0)
    }
    const fitMs = Math.min(...runs)
    // eslint-disable-next-line no-console
    // the work is real: every gap is read as a gap between flat faces
    expect(fit!.gaps).toHaveLength(8)
    expect(fit!.gaps.every((g) => g.flat === true), 'every gap is between flat faces').toBe(true)
    expect(fitMs / scanMs, `fitFacts ${fitMs.toFixed(0)} ms against one pass of ${scanMs.toFixed(1)} ms`).toBeLessThan(150)
  }, 120_000)
})
