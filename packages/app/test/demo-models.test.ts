// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The built-in examples. The hook, clip and bracket are the Vault starters' bodies: one closed part each, where the
// old clip was a ring and a foot 0.76 mm apart that printed as two pieces.
import { describe, expect, it } from 'vitest'
import { DEMO_MODELS } from '../src/lib/demo-models'

/** Edges used once (open) and the number of separate bodies, joined through shared vertices. */
function shape(positions: Float32Array, indices: Uint32Array): { open: number; bodies: number } {
  // Vertices at the same place are one vertex.
  const key = (i: number) => `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`
  const id = new Map<string, number>()
  const v = Array.from({ length: positions.length / 3 }, (_, i) => {
    const k = key(i)
    if (!id.has(k)) id.set(k, id.size)
    return id.get(k)!
  })
  const edges = new Map<string, number>()
  const parent = Array.from({ length: id.size }, (_, i) => i)
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a]!)))
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [v[indices[t]!]!, v[indices[t + 1]!]!, v[indices[t + 2]!]!]
    for (let k = 0; k < 3; k++) {
      const [a, b] = [tri[k]!, tri[(k + 1) % 3]!]
      const e = a < b ? `${a},${b}` : `${b},${a}`
      edges.set(e, (edges.get(e) ?? 0) + 1)
      parent[find(a)] = find(b)
    }
  }
  const used = new Set(Array.from(indices, (i) => find(v[i]!)))
  return { open: [...edges.values()].filter((n) => n % 2 === 1).length, bodies: used.size }
}

describe('built-in examples', () => {
  it.each(['wall-hook', 'cable-clip', 'shelf-bracket'])('%s is one closed body with its color', async (slug) => {
    const m = DEMO_MODELS.find((d) => d.slug === slug)!
    const { parts, colors } = await m.build()
    expect(parts).toHaveLength(1)
    expect(colors[0]).toMatch(/^#[0-9a-f]{6}$/)
    expect(shape(parts[0]!.positions, parts[0]!.indices)).toEqual({ open: 0, bodies: 1 })
  })

  it('every example builds', async () => {
    for (const m of DEMO_MODELS) expect((await m.build()).parts.length).toBeGreaterThan(0)
  })
})
