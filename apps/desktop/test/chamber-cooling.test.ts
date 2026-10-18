// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The chamber cooling mode a slice wrote (chamber_cooling_mode, read by the Snapmaker U1's start G-code) reaches the
// slice result the app reads: from the native engine's report on the desktop, and from the shards the browser's worker
// pool merges.
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
const { chamberCoolingOf, plateFacts } = await import('@slicerx/slicer')

const chamber = { mode: 2, source: 'derived', filaments: ['PLA'], text: 'chamber cooling mode 2, strong cooling (external circulation), from the filaments: PLA' }
const report = (extra: Record<string, unknown> = {}) => ({ id: 7, layerCount: 2, layerZ: [0.2, 0.4], layerTimeS: [1, 1], stats: { timeS: 2, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, warnings: [], ...extra })
const req = { plate: { objects: [] }, config: {} } as never

describe('a desktop slice', () => {
  it("carries the engine's chamber cooling report", async () => {
    tauri.report = report({ chamberCooling: chamber })
    expect((await createTauriSlicer().slice(req)).chamberCooling).toEqual(chamber)
  })

  it('has none when the G-code reads no chamber mode', async () => {
    tauri.report = report()
    expect(await createTauriSlicer().slice(req)).not.toHaveProperty('chamberCooling')
  })
})

describe("the worker pool's merged result", () => {
  const info = (chamberCooling: unknown) => ({ layerCount: 9, first: 0, last: 3, layerZ: [], layerTimeS: [], stats: { time_s: 1, filament_mm: [1], filament_g: [1], cost: 0, tool_changes: 0 }, stageMicros: {}, warnings: [], toolCount: 1, chamberCooling }) as never

  it('takes the chamber cooling mode the shards carry (every shard has the whole plate\'s)', () => {
    const settings = { mode: 0, source: 'config', text: 'chamber cooling mode 0, keep warm (internal circulation), from the settings' }
    expect(plateFacts([info(settings), info(settings), info(settings)])).toEqual({ chamberCooling: settings })
    expect(plateFacts([info(chamber), info(chamber)]).chamberCooling).toEqual(chamber)
  })

  it('leaves it out when the shards carry none', () => {
    expect(plateFacts([info(null), info(null)])).toEqual({})
    expect(plateFacts([])).toEqual({})
  })

  it('reads only a whole report', () => {
    expect(chamberCoolingOf({ mode: 1, source: 'derived', filaments: [], text: 'weak' })).toEqual({ mode: 1, source: 'derived', text: 'weak' })
    expect(chamberCoolingOf({ mode: 1.5, source: 'derived', text: 'x' })).toBeUndefined()
    expect(chamberCoolingOf({ mode: 1, source: 'guess', text: 'x' })).toBeUndefined()
    expect(chamberCoolingOf({ mode: 1, source: 'config' })).toBeUndefined()
    expect(chamberCoolingOf('2')).toBeUndefined()
  })
})
