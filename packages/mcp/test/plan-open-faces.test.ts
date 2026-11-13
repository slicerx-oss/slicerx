// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client plan names the faces of a piece meant to be open (openFaces), such as the open top of a cup: design.put_plan
// keeps them on the plan for later checks, refuses names that make no sense, and keeps a plan without them as before.
import type { DesignHost } from '@slicerx/cad-history'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, openFacesProblem, partPlanSchema, type PartPlan } from '../src/design-check'
import { amendShapeProblem } from '../src/plan-amend'
import { PlanInputSchema } from '../src/tab-tools'
import { designToolset } from '../src/toolset'
import { connect, data, text } from './helpers'

const host = { get: (id: string) => { throw new Error(`no design ${id}`) }, list: () => [] } as unknown as DesignHost

const cup: PartPlan = {
  planId: 'cup-1',
  part: 'Pen cup',
  units: 'mm',
  features: [{ name: 'Body', kind: 'shell', sizes: { diameter: 70, height: 100, wall: 2, floor: 3 } }],
  overall: { x: 70, y: 70, z: 100 },
  assumptions: [],
  questions: [],
}

function tools() {
  const plans = createPlanRegistry()
  const set = designToolset(host, {}, { plans })
  const put = set.find((t) => t.name === 'design.put_plan')!
  const run = (args: Record<string, unknown>) => put.run(put.input.parse(args) as never, {} as ToolContext)
  /** The refusal messages for these args, as the server would give them; [] when the input parses. */
  const issues = (args: Record<string, unknown>) => {
    const r = put.input.safeParse(args)
    return r.success ? [] : r.error.issues.map((i) => i.message)
  }
  return { plans, put, run, issues }
}

describe('design.put_plan openFaces', () => {
  it('is 1.6.0, and says in its description and schema what openFaces is', () => {
    const { put } = tools()
    expect(put.version).toBe('1.7.0')
    expect(put.description).toContain('its open faces in openFaces')
    expect(partPlanSchema.shape.openFaces.description).toContain('[{ "piece": "Pen cup", "faces": ["top"] }]')
  })

  it('keeps the open faces on the plan, and names them in the result', async () => {
    const { plans, run } = tools()
    const openFaces = [{ piece: 'Pen cup', faces: ['top'] }]
    const kept = await run({ plan: { ...cup, openFaces } })
    expect(plans.get('cup-1')!.plan.openFaces).toEqual(openFaces)
    expect(kept.output).toMatchObject({ planId: 'cup-1', openFaces })
    expect(kept.summary).toContain('Kept plan cup-1 for Pen cup (1 feature, 70 x 70 x 100 mm overall, Pen cup open at the top)')
  })

  it('takes a printInPlace piece and several faces of one piece', async () => {
    const { plans, run } = tools()
    const openFaces = [{ piece: 'Tray', faces: ['top', 'front'] }, { piece: 'Pen cup', faces: ['bottom'] }]
    const kept = await run({ plan: { ...cup, printInPlace: ['Lid', 'Tray'], openFaces } })
    expect(plans.get('cup-1')!.plan.openFaces).toEqual(openFaces)
    expect(kept.summary).toContain('Tray open at the top and front, Pen cup open at the bottom')
  })

  it('keeps a plan without openFaces exactly as before', async () => {
    const { plans, run } = tools()
    const kept = await run({ plan: cup })
    expect(plans.get('cup-1')).toEqual({ plan: cup, origin: 'client' })
    expect(kept.output).toEqual({ planId: 'cup-1', part: 'Pen cup', features: 1, holes: 0, underFloors: [] })
    expect(kept.summary).toBe('Kept plan cup-1 for Pen cup (1 feature, 70 x 70 x 100 mm overall). Build it, then check it with design.check and planId cup-1.')
  })

  it('refuses an unknown face name', () => {
    expect(tools().issues({ plan: { ...cup, openFaces: [{ piece: 'Pen cup', faces: ['rim'] }] } })).toEqual(['"rim" is no face; a face is top, bottom, front, back, left, right'])
  })

  it('refuses a face named twice, and a piece named twice', () => {
    const { issues } = tools()
    expect(issues({ plan: { ...cup, openFaces: [{ piece: 'Pen cup', faces: ['top', 'top'] }] } })).toEqual(['openFaces names top of Pen cup more than once; name each open face once'])
    expect(issues({ plan: { ...cup, openFaces: [{ piece: 'Pen cup', faces: ['top'] }, { piece: 'Pen cup', faces: ['bottom'] }] } })).toEqual(['openFaces names Pen cup more than once; give each piece one entry with all its open faces'])
  })

  it('refuses all six faces open', () => {
    const faces = ['top', 'bottom', 'front', 'back', 'left', 'right']
    expect(tools().issues({ plan: { ...cup, openFaces: [{ piece: 'Pen cup', faces }] } })).toEqual(['openFaces names all six faces of Pen cup open, which leaves no part; name only the faces meant to be open, such as top for a cup'])
  })

  it('refuses an empty list and a piece with no faces', () => {
    const { issues } = tools()
    expect(issues({ plan: { ...cup, openFaces: [] } })).toEqual(['openFaces is empty; leave it out when no face is open'])
    expect(issues({ plan: { ...cup, openFaces: [{ piece: 'Pen cup', faces: [] }] } })).toEqual(['name at least one open face, or leave the piece out of openFaces'])
  })

  it('refuses wrong types', () => {
    const { issues } = tools()
    for (const openFaces of ['top', { piece: 'Pen cup', faces: ['top'] }, [{ piece: 'Pen cup', faces: 'top' }], [{ piece: 3, faces: ['top'] }], [{ faces: ['top'] }], [{ piece: 'Pen cup', faces: [1] }], [{ piece: '  ', faces: ['top'] }], null])
      expect(issues({ plan: { ...cup, openFaces } }).length, JSON.stringify(openFaces)).toBeGreaterThan(0)
  })

  it('refuses a piece the plan does not have, and keeps nothing', async () => {
    const { plans, run } = tools()
    await expect(run({ plan: { ...cup, openFaces: [{ piece: 'Lid', faces: ['top'] }] } })).rejects.toThrow('openFaces: Lid is no piece of this plan; name the part (Pen cup)')
    await expect(run({ plan: { ...cup, printInPlace: ['Lid', 'Tray'], openFaces: [{ piece: 'Base', faces: ['top'] }, { piece: 'Cap', faces: ['top'] }] } })).rejects.toThrow('openFaces: Base, Cap are no pieces of this plan; name the part (Pen cup) or a piece printInPlace names')
    expect(plans.get('cup-1')).toBeUndefined()
    expect(openFacesProblem({ ...cup, printInPlace: false, openFaces: [{ piece: 'Pen cup', faces: ['top'] }] })).toBeNull()
  })

  it('is refused by name over the MCP server, as a client sees it', async () => {
    const h = await connect({ geomEngine: async () => Promise.reject(new Error('no engine here')) })
    const bad = await h.call('slicerx_design_put_plan', { plan: { ...cup, openFaces: [{ piece: 'Pen cup', faces: ['rim'] }] } })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('"rim" is no face; a face is top, bottom, front, back, left, right')
    const missing = await h.call('slicerx_design_put_plan', { plan: { ...cup, openFaces: [{ piece: 'Mug', faces: ['top'] }] } })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('openFaces: Mug is no piece of this plan; name the part (Pen cup)')
    const ok = await h.call('slicerx_design_put_plan', { plan: { ...cup, openFaces: [{ piece: 'Pen cup', faces: ['top'] }] } })
    expect(ok.isError, text(ok)).toBeFalsy()
    expect(data<{ output: { openFaces: unknown } }>(ok).output.openFaces).toEqual([{ piece: 'Pen cup', faces: ['top'] }])
  })

  it("leaves the mimir tab's plan card input without openFaces", () => {
    expect(Object.keys(PlanInputSchema.shape)).not.toContain('openFaces')
    const parsed = PlanInputSchema.parse({ ...cup, openFaces: [{ piece: 'Pen cup', faces: ['top'] }] })
    expect(parsed).not.toHaveProperty('openFaces')
  })

  it('keeps its open faces through an amend, which changes sizes only', () => {
    const was: PartPlan = { ...cup, openFaces: [{ piece: 'Pen cup', faces: ['top'] }] }
    expect(amendShapeProblem(was, { ...was, features: [{ ...was.features[0]!, sizes: { ...was.features[0]!.sizes, height: 110 } }] })).toBeNull()
    expect(amendShapeProblem(was, { ...was, openFaces: [{ piece: 'Pen cup', faces: ['bottom'] }] })).toBe('openFaces: an amend changes sizes only; the plan keeps its openFaces as they are')
    expect(amendShapeProblem(was, { ...was, openFaces: undefined })).toBe('openFaces: an amend changes sizes only; the plan keeps its openFaces as they are')
    expect(amendShapeProblem(cup, was)).toBe('openFaces: an amend changes sizes only; leave out openFaces')
  })
})
