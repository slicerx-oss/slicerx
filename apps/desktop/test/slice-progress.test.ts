// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A desktop slice reports progress: the engine's stage and fraction come over a channel a few times a second, and the
// app sees one fraction of the whole slice that only grows and ends at 1. Before, desktop slices said "layers, 0" once.
import { describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ steps: [] as { stage: string; fraction: number }[] }))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => undefined
  },
  // A fake engine: it sends its steps on the channel the command was given, then the report.
  invoke: async (cmd: string, args?: { onProgress?: { onmessage: (m: unknown) => void } }) => {
    if (cmd !== 'slice') return null
    for (const s of tauri.steps) args?.onProgress?.onmessage(s)
    return { id: 7, layerCount: 3, layerZ: [0.2, 0.4, 0.6], layerTimeS: [1, 1, 1], stats: { timeS: 3, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, warnings: [] }
  },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }))

const { createTauriSlicer, overallProgress } = await import('../src/host/slicer')

describe('desktop slice progress', () => {
  it('reaches the app as one fraction that only grows and ends at 1', async () => {
    tauri.steps = [
      { stage: 'contours', fraction: 0 },
      { stage: 'contours', fraction: 0.5 },
      { stage: 'contours', fraction: 1 },
      { stage: 'perimeters', fraction: 0.3 },
      { stage: 'perimeters', fraction: 1 },
      { stage: 'paths', fraction: 0.2 },
      { stage: 'paths', fraction: 0.7 },
      { stage: 'paths', fraction: 1 },
      { stage: 'gcode', fraction: 0 },
      { stage: 'gcode', fraction: 1 },
      { stage: 'preview', fraction: 1 },
    ]
    const seen: { stage: string; fraction: number }[] = []
    await createTauriSlicer().slice({ plate: { objects: [] }, config: {} } as never, { onProgress: (p) => void seen.push(p) })
    const f = seen.map((p) => p.fraction)
    expect(new Set(f).size).toBeGreaterThanOrEqual(5)
    expect(f.every((x, i) => i === 0 || x >= f[i - 1]!)).toBe(true)
    expect(f.at(-1)).toBe(1)
    expect(seen.at(-1)!.stage).toBe('preview')
  })

  it('never goes back, and passes over a stage the engine did not report', () => {
    const at = overallProgress()
    expect(at('contours', 1)).toBeCloseTo(0.25)
    // Perimeters never came; paths starts where they would have ended.
    expect(at('paths', 0)).toBeCloseTo(0.55)
    expect(at('paths', 0.5)).toBeCloseTo(0.725)
    // A report that comes in late does not move the bar back.
    expect(at('contours', 0.4)).toBeCloseTo(0.725)
    expect(at('preview', 1)).toBe(1)
  })
})
