// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client's own plan of a real thing gives its real sizes with where each came from: the page as source, or the
// person's words as stated. design.put_plan holds the planned sizes to them at scale, as design.plan holds a display
// plan on the mimir tab, and design.get_plan reads the kept plan back. Driven over the MCP server as a client sees it.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'

/** A stand-in engine: the design tools come with one, and no step here builds geometry. */
const engine = { geomEngine: async () => ({ mesh: { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] } }) }

const page = { title: 'Bridge facts', url: 'https://example.org/bridge' }

/** A suspension bridge at 1:2000, as a client plans it: no card, its own planId. */
const bridge = {
  planId: 'bridge-1',
  part: 'Suspension bridge',
  units: 'mm',
  scale: 2000,
  real: [
    { feature: 'Deck', size: 'length', mm: 280000, source: page },
    { feature: 'Main tower', size: 'height', mm: 227000, stated: 'the towers are 227 m tall' },
  ],
  features: [
    { name: 'Deck', kind: 'extrude', sizes: { length: 140, width: 14, height: 3 } },
    { name: 'Main tower', kind: 'extrude', sizes: { width: 6, depth: 6, height: 100 } },
  ],
  assumptions: [],
  questions: [],
}

describe('design.put_plan with real sizes, over the MCP server', () => {
  it('keeps a plan whose real sizes give their sources, and design.get_plan reads them back', async () => {
    const h = await connect(engine)
    const put = await h.call('slicerx_design_put_plan', { plan: bridge })
    expect(put.isError, text(put)).toBeFalsy()
    expect(data<{ output: { scale: number; real: unknown[] } }>(put).output).toMatchObject({ scale: 2000, real: bridge.real })
    const got = await h.call('slicerx_design_get_plan', { planId: 'bridge-1' })
    expect(got.isError, text(got)).toBeFalsy()
    expect(text(got)).toContain('Plan bridge-1 for Suspension bridge: 2 features, 2 real sizes')
    expect(data<{ output: { plan: { real: unknown[] }; origin: string } }>(got).output).toMatchObject({ origin: 'client', plan: { scale: 2000, real: bridge.real } })
    const none = await h.call('slicerx_design_get_plan', { planId: 'bridge-9' })
    expect(none.isError).toBe(true)
    expect(text(none)).toContain('planId: no plan bridge-9 is kept')
  })

  it('holds the planned sizes to the real ones at scale, and refuses a real size with no source', async () => {
    const h = await connect(engine)
    const short = { ...bridge, features: bridge.features.map((f) => (f.name === 'Main tower' ? { ...f, sizes: { ...f.sizes, height: 60 } } : f)) }
    const off = await h.call('slicerx_design_put_plan', { plan: short })
    expect(off.isError).toBe(true)
    expect(text(off)).toContain('Main tower height is 60 mm, 0.5 times the 113.5 mm its real 227000 mm gives at 1:2000; size it from the real one')
    const bare = await h.call('slicerx_design_put_plan', { plan: { ...bridge, real: bridge.real.map(({ feature, size, mm }) => ({ feature, size, mm })) } })
    expect(bare.isError).toBe(true)
    expect(text(bare)).toContain('real: Deck length and Main tower height give no source; give the page each came from as source {"title", "url"}, or the person\'s words that give it as stated')
    const misread = await h.call('slicerx_design_put_plan', { plan: { ...bridge, real: [bridge.real[0], { ...bridge.real[1], stated: 'the towers are 300 m tall' }] } })
    expect(misread.isError).toBe(true)
    expect(text(misread)).toContain('real: Main tower height is 227000 mm, but "the towers are 300 m tall" gives no size within 1% of that')
  })
})
