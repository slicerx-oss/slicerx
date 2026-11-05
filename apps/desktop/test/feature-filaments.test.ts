// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The filaments each object's features printed with reach the slice result the app reads from the native engine's
// report, so the Color tab can show what each feature printed with.
import { describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ report: null as unknown }))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => undefined
  },
  invoke: async (cmd: string) => (cmd === 'slice' ? tauri.report : null),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }))

const { createTauriSlicer } = await import('../src/host/slicer')
const { featureFilamentsOf, joinFeatureFilaments, plateFacts } = await import('@slicerx/slicer')

const report = (extra: Record<string, unknown> = {}) => ({ id: 7, layerCount: 2, layerZ: [0.2, 0.4], layerTimeS: [1, 1], stats: { timeS: 2, filamentMm: [1, 1], filamentG: [1, 1], cost: 0, toolChanges: 1 }, stageMicros: {}, warnings: [], ...extra })
const req = { plate: { objects: [] }, config: {} } as never
const used = [{ object: 'obj-1', name: 'Box', features: { outerWall: [2], sparseInfill: [1, 2] } }]

describe('a desktop slice', () => {
  it("carries the engine's feature filaments", async () => {
    tauri.report = report({ featureFilaments: used })
    expect((await createTauriSlicer().slice(req)).featureFilaments).toEqual(used)
  })

  it('has none when the engine reports none', async () => {
    tauri.report = report()
    expect(await createTauriSlicer().slice(req)).not.toHaveProperty('featureFilaments')
  })
})

describe('reading the report', () => {
  it('keeps well formed entries and drops the rest', () => {
    expect(featureFilamentsOf([...used, { name: 'no object' }, null, { object: 'b', features: { support: [3, 'x', 0] } }])).toEqual([...used, { object: 'b', name: 'b', features: { support: [3] } }])
    expect(featureFilamentsOf(undefined)).toBeUndefined()
    expect(featureFilamentsOf([])).toBeUndefined()
  })

  it('keeps the engine object id, drops features that are not lists and entries whose features are not an object', () => {
    expect(featureFilamentsOf([{ object: 'a', engineObject: 'o0-2', name: 'A', features: { outerWall: [1], support: '2', sparseInfill: [1.5, -1, 2] } }, { object: 'b', features: [1] }])).toEqual([
      { object: 'a', engineObject: 'o0-2', name: 'A', features: { outerWall: [1], sparseInfill: [2] } },
    ])
  })
})

describe("the worker pool's merged result", () => {
  // Shards split the plate by layers: one prints the bottom of a, the other its top and all of b.
  const info = (featureFilaments: unknown) => ({ layerCount: 9, first: 0, last: 3, layerZ: [], layerTimeS: [], stats: { time_s: 1, filament_mm: [1], filament_g: [1], cost: 0, tool_changes: 0 }, stageMicros: {}, warnings: [], toolCount: 2, featureFilaments }) as never
  const low = [{ object: 'a', name: 'A', features: { outerWall: [1], bottomSurface: [1] } }]
  const high = [
    { object: 'a', name: 'A', features: { outerWall: [2], topSurface: [2] } },
    { object: 'b', name: 'B', features: { outerWall: [1] } },
  ]

  it("unions each object's feature slots across the shards", () => {
    expect(plateFacts([info(low), info(high)]).featureFilaments).toEqual([
      { object: 'a', name: 'A', features: { outerWall: [1, 2], bottomSurface: [1], topSurface: [2] } },
      { object: 'b', name: 'B', features: { outerWall: [1] } },
    ])
    expect(joinFeatureFilaments([high, low])![0]!.features['outerWall']).toEqual([1, 2])
  })

  it("keeps an object's nozzle size, from whichever shard printed the object", () => {
    // On a printer whose nozzles differ in size each entry names its nozzle; a shard where b printed nothing names none.
    const sized = [{ object: 'b', name: 'B', features: {} }]
    const printed = [{ object: 'b', name: 'B', features: { outerWall: [2] }, nozzleMm: 0.6 }]
    expect(featureFilamentsOf([{ object: 'b', name: 'B', features: {}, nozzleMm: 'x' }])).toEqual([{ object: 'b', name: 'B', features: {} }])
    expect(plateFacts([info(sized), info(printed)]).featureFilaments).toEqual([{ object: 'b', name: 'B', features: { outerWall: [2] }, nozzleMm: 0.6 }])
  })

  it('leaves it out when no shard reports it', () => {
    expect(plateFacts([info(undefined), info(null)])).not.toHaveProperty('featureFilaments')
    expect(joinFeatureFilaments([undefined])).toBeUndefined()
  })
})
