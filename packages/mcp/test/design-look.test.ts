// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.look draws a design for the model of the turn to look at on a vague follow-up: a 512 px picture with its
// edges drawn, and a side picture when asked, in the project's filament colors. The tab offers it to a cloud model
// only, and shows it as one plain line.
import { surfaceTools } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { headlessDesignHost } from '../evals/creative/design-host'
import { LOOK_PX, VISIBLE_FLOOR_PCT } from '../src/look'
import { createCardPlans, createPlanRegistry, tabToolset } from '../src/toolset'
import { useGeomEngine } from './geom-engine'

const g = useGeomEngine('design-look')

describe('design.look', () => {
  it('draws a pod with its edges, from above and from the side, and names nothing changed', async () => {
    const host = headlessDesignHost((op, request) => g.engine(op, request))
    const tools = tabToolset(host, createCardPlans(createPlanRegistry()), { filaments: { list: () => [{ slot: 1, type: 'PLA', color: '#f2f2f2' }, { slot: 2, type: 'PLA', color: '#b22222' }], add: () => {}, set: () => {} } })
    const tool = (n: string) => tools.find((t) => t.name === n)!
    const run = (n: string, a: unknown) => tool(n).run(tool(n).input.parse(a) as never, {} as never)
    const d = ((await run('design.new', { name: 'Pod' })).output as { design: string }).design
    const section = (x: number, half: number) => ({ frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: [[-half, 0], [half, 0], [half, 12], [-half, 12]] }] })
    await run('geom.loft', { design: d, profiles: [section(0, 4), section(40, 12), section(80, 6)], name: 'Body', slot: 2 })
    const one = await run('design.look', { design: d })
    expect(one.summary).toBe('Looked at the model')
    expect(one.images).toHaveLength(1)
    expect(one.images![0]!.mime).toBe('image/png')
    const png = Buffer.from(one.images![0]!.data, 'base64')
    // the PNG's width, from its header
    expect(Math.max(png.readUInt32BE(16), png.readUInt32BE(20))).toBe(LOOK_PX)
    const two = await run('design.look', { design: d, side: true })
    expect(two.images).toHaveLength(2)
    expect(tool('design.look').permission).toBe('read')
  })

  it('measures how much of the whole-model view a change moved, against the look before it', async () => {
    const host = headlessDesignHost((op, request) => g.engine(op, request))
    const tools = tabToolset(host, createCardPlans(createPlanRegistry()))
    const tool = (n: string) => tools.find((t) => t.name === n)!
    const run = (n: string, a: unknown) => tool(n).run(tool(n).input.parse(a) as never, { sessionId: 's1' } as never)
    const d = ((await run('design.new', { name: 'Toy boat' })).output as { design: string }).design
    const section = (x: number, half: number) => ({ frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: [[-half, 0], [half, 0], [half, 12], [-half, 12]] }] })
    await run('geom.loft', { design: d, profiles: [section(0, 4), section(40, 12), section(80, 6)], name: 'Hull' })
    // nothing to compare with until the model was looked at
    expect((await run('design.look', { design: d, compare: true })).ok).toBe(false)
    await run('design.look', { design: d })
    const top = (x: number, y: number) => ({ origin: [x, y, 12], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
    // a 1 mm knob on the deck: under the floor
    await run('geom.extrude', { design: d, part: 0, operation: 'join', frame: top(40, 0), shape: { type: 'rectangle', widthMm: 1, heightMm: 1 }, distance_mm: 0.5 })
    const small = await run('design.look', { design: d, compare: true })
    const s1 = small.output as { visiblePct: number; floorPct: number; belowFloor: boolean }
    expect(s1.floorPct).toBe(VISIBLE_FLOOR_PCT)
    expect(s1.belowFloor).toBe(true)
    expect(small.summary).toMatch(/^Looked at the model again: [\d.]+% of the whole-model view changed since the look before the change, under the 2% a person sees at that view$/)
    expect(small.images).toHaveLength(1)
    // a deckhouse 30 mm long and 10 mm tall: well over it, measured against the same first look
    await run('geom.extrude', { design: d, part: 0, operation: 'join', frame: top(40, 0), shape: { type: 'rectangle', widthMm: 30, heightMm: 12 }, distance_mm: 10 })
    const big = (await run('design.look', { design: d, compare: true })).output as { visiblePct: number; belowFloor: boolean }
    expect(big.belowFloor).toBe(false)
    expect(big.visiblePct).toBeGreaterThan(s1.visiblePct + 5)
  })

  it('is offered to a cloud model in the tab and never to a local one', () => {
    const tools = tabToolset(headlessDesignHost(async () => ({})), createCardPlans(createPlanRegistry()))
    expect(surfaceTools('tab', false, tools).some((t) => t.name === 'design.look')).toBe(true)
    expect(surfaceTools('tab', true, tools).some((t) => t.name === 'design.look')).toBe(false)
  })
})
