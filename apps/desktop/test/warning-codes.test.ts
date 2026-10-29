// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The warnings a desktop slice returns keep the code the engine wrote and the fields it added, so the app shows an
// "objects overlap" note as itself and not as an unsupported setting.
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

const report = (warnings: unknown[]) => ({ id: 7, layerCount: 2, layerZ: [0.2, 0.4], layerTimeS: [1, 1], stats: { timeS: 2, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, warnings })
const req = { plate: { objects: [] }, config: {} } as never

describe('the warnings of a desktop slice', () => {
  it('keep the objects_overlap code, its layer and an object id', async () => {
    const w = { code: 'objects_overlap', message: 'A overlaps B on layer 1; the overlap prints once, as part of B.', layer: 0, objectId: 'obj-1' }
    tauri.report = report([w])
    expect((await createTauriSlicer().slice(req)).warnings).toEqual([w])
  })

  it('keep every code the engine writes', async () => {
    const codes = ['open_edges', 'thin_wall', 'floating_region', 'long_bridge', 'outside_bed', 'unsupported_setting', 'manual_step', 'safety_limit', 'collision', 'objects_overlap', 'tool_change_skipped']
    tauri.report = report(codes.map((code) => ({ code, message: code })))
    expect((await createTauriSlicer().slice(req)).warnings.map((w) => w.code)).toEqual(codes)
  })

  it('pass a code this build does not know through as written', async () => {
    tauri.report = report([{ code: 'brand_new_note', message: 'm' }])
    expect((await createTauriSlicer().slice(req)).warnings).toEqual([{ code: 'brand_new_note', message: 'm' }])
  })
})
