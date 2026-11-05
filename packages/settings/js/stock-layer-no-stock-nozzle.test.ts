// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A nozzle the catalog offers but the maker's stock profiles have no machine preset for (NO_STOCK_NOZZLE in resolved.ts)
// prints as if the printer had no resolved presets at all: SlicerX's process, machine and filament, every key the same
// as the stock layer built with the printer's resolved entry hidden.
import { afterEach, describe, expect, it, vi } from 'vitest'

const V3 = 'creality-ender-3-v3'
type Layer = { source: string; values: Record<string, unknown>; filamentIds: string[]; materialType: string; goalValues: unknown }

async function layers(hide: boolean): Promise<Layer[]> {
  vi.resetModules()
  if (hide) {
    vi.doMock('./resolved', async (orig) => {
      const real = await orig<typeof import('./resolved')>()
      return {
        ...real,
        hasResolved: (id: string) => id !== V3 && real.hasResolved(id),
        resolvedNozzles: async (id: string) => (id === V3 ? [] : real.resolvedNozzles(id)),
        resolvedProfile: async (id: string, ...rest: Parameters<typeof real.resolvedProfile> extends [string, ...infer R] ? R : never) =>
          id === V3 ? undefined : real.resolvedProfile(id, ...rest),
      }
    })
  }
  const { stockLayer } = await import('./stock-layer')
  const out: Layer[] = []
  for (const tier of ['draft', 'standard', 'fine', 'strong'] as const) {
    for (const slots of [[], [{ type: 'PLA' }], [{ type: 'PETG' }]]) {
      out.push((await stockLayer({ printerId: V3, tier, slots, nozzle: 0.8 })) as unknown as Layer)
    }
  }
  return out
}

describe('a nozzle with no stock machine preset', () => {
  afterEach(() => {
    vi.doUnmock('./resolved')
    vi.resetModules()
  })

  it('gives the plain Ender-3 V3 on 0.8 mm the layer it has without resolved presets, every key', async () => {
    const shipped = await layers(false)
    const without = await layers(true)
    expect(shipped.length).toBe(12)
    for (const [i, l] of shipped.entries()) {
      const w = without[i]!
      expect(l.source, `${i}`).toBe('slicerx')
      expect(w.source, `${i}`).toBe('slicerx')
      const keys = [...new Set([...Object.keys(l.values), ...Object.keys(w.values)])].sort()
      const wrong = keys.filter((k) => JSON.stringify(l.values[k]) !== JSON.stringify(w.values[k]))
      expect(wrong.join(', '), `${i}`).toBe('')
      expect(l.filamentIds, `${i}`).toEqual(w.filamentIds)
      expect(l.materialType, `${i}`).toBe(w.materialType)
      expect(l.goalValues, `${i}`).toEqual(w.goalValues)
    }
  })
})
