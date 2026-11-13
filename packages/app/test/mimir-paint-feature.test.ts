// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab paints a plan feature on the app's plate: paint.apply with feature tags the paint step, the plate's
// history keeps the tag, and a saved project reads it back.
import type { MeshHandle } from '@slicerx/contracts'
import type { PilotTool } from '@slicerx/pilot'
import { describe, expect, it, vi } from 'vitest'
import { readProject } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { history } from '../src/plate/history'
import { get, set } from '../src/state/store'
import { clearPlans } from '../src/workspaces/mimir/plan-tool'
import { toolsFor } from '../src/workspaces/mimir/session'
import { useGeomEngine } from './geom-engine'

useGeomEngine('mimir-paint-feature-replies', { compressed: true, freshCache: true })

const loader = { loadParts: async (name: string): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: 12, bboxMm: [20, 10, 8], openEdges: 0, parts: [] }) }

describe('a paint step the mimir tab tags with its plan feature', () => {
  it('keeps the feature on the plate history, and a saved project reads it back', async () => {
    // step ids carry the time and go into the saved file the engine reads, so a fixed clock keeps that request as recorded
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
    try {
      await tagged()
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)
})

/** Builds a hull, paints its top tagged Hull paint, and reads the tag back from the plate and a saved project. */
async function tagged() {
  clearPlans()
  history().clear()
  set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', selection: null, selectedIds: [], historyEdit: null, slotSetup: {}, printerSlots: [], fileSlotColors: [], fileSlotTypes: [] })
  const tools = new Map<string, PilotTool<never>>(toolsFor(loader).map((t) => [t.name, t]))
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.get(name)!
    return t.run(t.input.parse(args) as never, {} as never)
  }
  const design = ((await call('design.new', { name: 'Hull' })).output as { design: string }).design
  const hull = await call('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 5, feature: 'Hull' })
  expect(hull.ok, hull.summary).not.toBe(false)
  const pv = (await call('paint.preview', { design, state: 2, target: { kind: 'direction', direction: 'top' } })).output as { preview: string }
  const applied = await call('paint.apply', { preview: pv.preview, feature: 'Hull paint' })
  expect(applied.ok, applied.summary).toBe(true)

  const e = get().plate[0]!
  const listed = (await call('design.steps', { design })).output as { steps: { name: string; feature?: string }[] }
  expect(listed.steps.map((s) => s.feature)).toEqual(['Hull', 'Hull paint'])
  const bed = { widthMm: 256, depthMm: 256 }
  const p = await readProject(writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [e], settings: { sequence: 'by-layer' } }], bed, settings: {} }), bed)
  const back = p.plates[0]!.objects[0]!
  const h = p.histories.get(back.fileId)!
  expect(h.steps.map((s) => [s.params.op, s.feature])).toEqual([
    ['shape.extrude', 'Hull'],
    ['paint', 'Hull paint'],
  ])
}
