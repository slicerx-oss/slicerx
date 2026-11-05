// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exploded views for clients: design.render draws a design's parts moved apart (the same offsets as the app's Spread
// control) without touching the design, and the app tools read and set the open app's spread through the app link.
import { describe, expect, it, vi } from 'vitest'
import { explodeOffsets } from '@slicerx/contracts/explode'
import { appExplodeTools, explodeSummary, type AppExplode } from '../src/app-explode'
import type { AppLinkCaller } from '../src/app-route'
import type { Designs } from '../src/design'
import { designRenderTools, partBox } from '../src/design-render'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const block = (x: number, z = 0) => ({ name: `b${x}`, slot: 1 + x / 10, positions: [x, 0, z, x + 10, 0, z, x, 10, z, x, 0, z + 10], indices: [0, 2, 1, 0, 1, 3] })

function host(parts: ReturnType<typeof block>[], transform = [...IDENTITY]) {
  const design = { id: 'd1', name: 'Hinge', parts, transform, history: { steps: [] } }
  const engine = vi.fn(async (_op: string, req: unknown) => ({ view: (req as { view: string }).view, widthPx: 384, heightPx: 300, objects: (req as { objects: unknown[] }).objects.length, pngBase64: 'iVBORw0KGgo=' }))
  const designs = { get: () => design, deps: { engine } } as unknown as Designs
  const [render] = designRenderTools(designs)
  return { design, engine, render: render! }
}

const sent = (engine: ReturnType<typeof host>['engine']) => engine.mock.calls.at(-1)![1] as { objects: { transform: number[]; slot: number }[]; view: string; image: boolean }

describe('design.render', () => {
  it('draws the design whole by default, one object per part, the PNG only when asked', async () => {
    const { render, engine } = host([block(0), block(10)])
    expect(render.name).toBe('design.render')
    expect(render.permission).toBe('read')
    const r = await render.run(render.input.parse({ design: 'd1' }) as never, {} as never)
    const req = sent(engine)
    expect(engine).toHaveBeenLastCalledWith('render', expect.objectContaining({ view: 'iso', image: false }))
    expect(req.objects).toHaveLength(2)
    for (const o of req.objects) expect(o.transform).toEqual(IDENTITY)
    expect(r.output).toMatchObject({ spread: 0, axis: 'radial', offsetsMm: [[0, 0, 0], [0, 0, 0]] })
    expect(r.images).toBeUndefined()
    expect(r.output).not.toHaveProperty('pngBase64')
  })

  it('draws the parts moved apart by the spread, as the app does, and leaves the design as it was', async () => {
    const parts = [block(0), block(10, 10), block(20)]
    const turned = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1]
    const { render, engine, design } = host(parts, turned)
    const r = await render.run(render.input.parse({ design: 'd1', spread: 60, axis: 'z', image: true }) as never, {} as never)
    const want = explodeOffsets(parts.map((p) => partBox(p as never, turned)), 60, 'z')
    const req = sent(engine)
    req.objects.forEach((o, i) => {
      expect(o.transform.slice(12, 15)).toEqual([turned[12]! + want[i]![0], turned[13]! + want[i]![1], turned[14]! + want[i]![2]])
      // turned and scaled as before; only the move differs
      expect(o.transform.slice(0, 12)).toEqual(turned.slice(0, 12))
      expect(o.slot).toBe(parts[i]!.slot)
    })
    // the lowest part stays, the others rise
    expect(want.some((o) => o[2] > 0)).toBe(true)
    expect((r.output as { offsetsMm: number[][] }).offsetsMm.map((o) => o[2])).toEqual(want.map((o) => Math.round(o[2] * 100) / 100))
    expect(r.images).toEqual([{ mime: 'image/png', data: 'iVBORw0KGgo=' }])
    expect(r.summary).toBe('Drew Hinge (3 parts) from the iso view, spread 60 percent along Z')
    expect(design.transform).toEqual(turned)
    expect(design.parts).toBe(parts)
  })

  it('moves the parts by the fixed amounts for a known case', async () => {
    // two 10 mm blocks side by side at identity, along X at 100 percent: a step of 10 mm and a quarter, half each way
    const { render, engine } = host([block(0), block(10)])
    const r = await render.run(render.input.parse({ design: 'd1', spread: 100, axis: 'x' }) as never, {} as never)
    expect((r.output as { offsetsMm: number[][] }).offsetsMm).toEqual([[-6.25, 0, 0], [6.25, 0, 0]])
    expect(sent(engine).objects.map((o) => o.transform.slice(12, 15))).toEqual([[-6.25, 0, 0], [6.25, 0, 0]])
  })

  it('measures a part through the design transform', () => {
    // a quarter turn about Z and a move of (5, 6, 0): the block's own (x, y) goes to (5 - y, 6 + x)
    const turned = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1]
    expect(partBox(block(10) as never, turned)).toEqual({ min: [-5, 16, 0], max: [5, 26, 10] })
  })

  it('checks the spread and the axis before anything is drawn', () => {
    const { render } = host([block(0)])
    for (const bad of [{ design: 'd1', spread: 101 }, { design: 'd1', spread: -1 }, { design: 'd1', axis: 'w' }]) expect(render.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })
})

describe('app explode tools', () => {
  it('read and set the spread, each answer read back from the app', async () => {
    let state: AppExplode = { spread: 0, axis: 'radial', targets: [{ id: 'k', name: 'Kit', parts: 3 }], shown: false, held: false, drawn: {} }
    const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === 'explode.set') state = { ...state, ...args, shown: true, drawn: { k: [[-5, 0, 0], [0, 0, 0], [5, 0, 0]] } }
      return state
    })
    const [get, set] = appExplodeTools({ call } as AppLinkCaller, 'SlicerX')
    expect([get!.name, set!.name]).toEqual(['app.explode', 'app.explode_set'])
    expect([get!.permission, set!.permission]).toEqual(['read', 'read'])
    expect((await get!.run({} as never, {} as never)).summary).toBe('Drawn whole (spread 0, axis radial): Kit (3 parts).')
    const r = await set!.run(set!.input.parse({ spread: 60, axis: 'x' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('explode.set', { spread: 60, axis: 'x' })
    expect(r.summary).toBe('Spread 60 percent along X: Kit (3 parts).')
    expect((r.output as AppExplode).drawn).toEqual({ k: [[-5, 0, 0], [0, 0, 0], [5, 0, 0]] })
  })

  it('check the arguments before anything leaves, and pass the refusal on', async () => {
    const [, set] = appExplodeTools({ call: vi.fn() } as unknown as AppLinkCaller, 'SlicerX')
    for (const bad of [{}, { spread: 150 }, { axis: 'w' }, { spread: '50' }]) expect(set!.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    const refusing = { call: async () => { throw Object.assign(new Error('select an object with 2 parts or more first'), { code: 'not_found' }) } } as unknown as AppLinkCaller
    const [, set2] = appExplodeTools(refusing, 'SlicerX')
    await expect(set2!.run(set2!.input.parse({ spread: 40 }) as never, {} as never)).rejects.toMatchObject({ code: 'not_found' })
    const [get3] = appExplodeTools(undefined, 'SlicerX')
    await expect(get3!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
    for (const code of ['app_closed', 'app_link_off', 'forbidden', 'unauthorized']) {
      const off = { call: async () => { throw Object.assign(new Error(code), { code }) } } as unknown as AppLinkCaller
      await expect(appExplodeTools(off, 'SlicerX')[0]!.run({} as never, {} as never), code).rejects.toMatchObject({ code: 'not_configured' })
    }
    const busy = { call: async () => { throw Object.assign(new Error('an edit tool is open'), { code: 'busy' }) } } as unknown as AppLinkCaller
    await expect(appExplodeTools(busy, 'SlicerX')[1]!.run({ spread: 30 } as never, {} as never)).rejects.toMatchObject({ code: 'busy' })
  })

  it('says when the spread is not drawn now', () => {
    expect(explodeSummary({ spread: 40, axis: 'z', targets: [{ id: 'k', name: 'Kit', parts: 2 }], shown: false, held: true, drawn: {} })).toBe('Spread 40 percent along Z: Kit (2 parts). Not drawn now: the view shows the toolpaths or an edit tool is open.')
  })
})
