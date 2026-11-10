// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A first failed design.check says that the plan's one fix round is open: fix the failed items and check again. A
// hinged box built on Haiku (the base and a lid on a pin, printed in place) ran geom.extrude, shell, build, boolean,
// build, build, boolean, then geom.fit_check and design.check. The check failed on the lid's gaps, 0.295 mm over the box
// and 0.28 mm beside it under the 0.4 and 0.3 mm the fit rule wants, and on the size the lid's knuckles made. Its result
// listed the failed items and nothing more, and the reply read it as the end: "the design check failed, so I have
// stopped there". The engine's fit report is stubbed with that run's two gaps.
import type { Design as HostDesign, DesignHost, HistoryMesh } from '@slicerx/cad-history'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { fixRoundOpen } from '../src/design-check'
import * as toolset from '../src/toolset'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A closed box from `a` to `b`, as one part named `name`. */
function box(name: string, a: [number, number, number], b: [number, number, number]): HistoryMesh {
  const v = (i: number): number[] => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]]
  const faces = [
    [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4],
    [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5],
  ]
  return { name, slot: 0, positions: [0, 1, 2, 3, 4, 5, 6, 7].flatMap(v), indices: faces.flat() }
}

// the box with its knuckles out the back, 56.5 mm deep where the plan says 50, and the lid 0.295 mm over it, 37.4 mm tall
const hinged = {
  id: 'd1',
  name: 'Hinged box',
  // the bodies only: its steps are not replayed here, so the feature count fails too, as it did in the run
  history: { version: 1, base: [], steps: [] },
  transform: IDENTITY,
  parts: [box('Base', [0, 0, 0], [80, 56.5, 33]), box('Lid', [0, 0, 33.295], [80, 50, 37.4])],
  status: [],
  madeBy: {},
  redo: [],
} as unknown as HostDesign

// the fit report as the run read it: the lid 0.295 mm over the box and 0.28 mm beside it
const report = {
  parts: [
    { bounds: { min: [0, 0, 0], max: [80, 56.5, 33] }, item: 0 },
    { bounds: { min: [0, 0, 33.295], max: [80, 50, 37.4] }, item: 1 },
  ],
  gaps: [
    { parts: [0, 1], gapMm: 0.295, limitMm: 0.4, kind: 'vertical', from: [40, 25, 33], to: [40, 25, 33.295] },
    { parts: [0, 1], gapMm: 0.28, limitMm: 0.3, kind: 'horizontal', from: [12, 46, 30.5], to: [12.28, 46, 30.5] },
  ],
  pieces: 2,
}

const plan = {
  planId: 'plan_mwb2dckl25h55',
  part: 'Hinged box',
  units: 'mm' as const,
  overall: { x: 80, y: 50, z: 35 },
  features: [
    { name: 'Base shell', sizes: { length: 80, width: 50, height: 33, wall: 2, floor: 2 } },
    { name: 'Lid plate', sizes: { length: 80, width: 50, thickness: 2 } },
    { name: 'Hinge knuckles', sizes: { knuckle_length: 12, knuckle_diameter: 5 } },
    { name: 'Hinge pin', sizes: { pin_diameter: 2 } },
  ],
  assumptions: ['The lid prints assembled on its hinge, closed over the box.'],
  questions: [],
  printInPlace: ['Base', 'Lid'],
}

type Out = { pass: boolean; stop?: string; items: { name: string; pass: boolean; got: string }[] }

/** The tab's tools on a host holding the built box, the plan approved on its card, and the run's fit check. */
async function hingedBoxRun(cardSide: boolean) {
  const host = { get: () => hinged, list: () => [hinged], call: async (op: string) => (op === 'fit.check' ? report : op === 'info' ? { watertight: true } : Promise.reject(new Error('no hole there'))) } as unknown as DesignHost
  const plans = toolset.createPlanRegistry()
  plans.put(plan, 'd1', 'card')
  const tools = toolset.designToolset(host, {}, { plans, cardSide, nozzleMm: () => 0.4 })
  const fit = tools.find((x) => x.name === 'geom.fit_check')!
  await fit.run(fit.input.parse({ design: 'd1' }), {} as ToolContext)
  const tool = tools.find((x) => x.name === 'design.check')!
  const check = async () => {
    const r = await tool.run(tool.input.parse({ planId: plan.planId }), {} as ToolContext)
    return { summary: r.summary ?? '', out: r.output as Out }
  }
  return { check, plans }
}

describe("a hinged box's first failed check", () => {
  it('says its fix round is open, what to change and to check again, and only the second failed check stops', async () => {
    const { check, plans } = await hingedBoxRun(true)
    const first = await check()
    expect(first.out.pass).toBe(false)
    expect(first.out.items.find((i) => i.name === 'gaps')).toMatchObject({ pass: false })
    expect(first.out.items.find((i) => i.name === 'gaps')!.got).toBe('Lid and Base are 0.3 mm apart on the top face of Base; this print-in-place plan needs 0.4 mm or more')
    expect(first.out.stop).toBeUndefined()
    // the failed items first, then the round that is open
    expect(first.summary).toMatch(/checks against plan plan_mwb2dckl25h55 failed: .*gaps \(want /)
    expect(first.summary.endsWith(`. ${fixRoundOpen(plan.planId)}`)).toBe(true)
    expect(first.summary).toContain('This is not the last check: the plan has one fix round, and it is open.')
    expect(first.summary).toContain('Fix each failed item now')
    expect(first.summary).toContain(`then check plan ${plan.planId} again`)
    expect(first.summary).toContain('Do not stop or ask the person yet')
    // the mimir card's step row shows it too: no tool name
    expect(fixRoundOpen(plan.planId)).not.toMatch(/design\.|geom\.|slicerx_/)
    expect(plans.get(plan.planId)?.failedChecks).toBe(1)
    // the part unchanged and checked again: the round is used, and the result says to stop, not that a round is open
    const second = await check()
    expect(second.out.stop).toMatch(/^The fix round is used: stop building/)
    expect(second.summary).not.toContain('This is not the last check')
  })

  it('says it the same way to an MCP client', async () => {
    const { check } = await hingedBoxRun(false)
    expect((await check()).summary).toContain(fixRoundOpen(plan.planId))
  })
})
