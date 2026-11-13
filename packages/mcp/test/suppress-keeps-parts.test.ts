// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Suppressing a step that takes parts away (a boolean's `with` parts) keeps every part: the step still numbers the
// parts as if it had run, and the parts it would have taken away stay in the design at the end of the parts list. A new
// body built after the boolean keeps its own place, every later step finds its part at the number it was made with, the
// form lines name how each part was made, a save and reopen gives the same parts, and turning the step back on gives
// the parts as they were.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IDENTITY, parseHistories, replayHistory, type Design, type History } from '@slicerx/cad-history'
import { connect, data, text, type Harness } from './helpers'
import { useGeomEngine } from './geom-engine'
import { maker } from '../src/sunk'
import { readZip } from '../src/zip'

const geom = useGeomEngine('suppress-keeps-parts')

interface Part {
  name: string
  sizeMm: [number, number, number]
}

async function start() {
  const h: Harness = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ summary: string; output: Record<string, any> }>(r)
  }
  const d = (await ok('slicerx_design_new', { name: 'Blocks' })).output['design'] as string
  // a 10 mm block, 10 mm tall, centered at x on the bed
  const box = (x: number, name: string) => ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, placement: { center: [x, 0] }, distance_mm: 10, operation: 'new', name })
  const steps = async (design = d) => (await ok('slicerx_design_steps', { design })).output
  const names = (o: Record<string, any>) => (o['parts'] as Part[]).map((p) => p.name)
  return { h, ok, d, box, steps, names }
}

const round = (v: number) => Math.round(v * 10) / 10

/** The design's history as its saved file holds it. */
function savedHistory(path: string): History {
  const z = readZip(readFileSync(path))
  const files = new Map<string, Uint8Array>(z.names().map((n) => [n, z.read(n)!]))
  const ids = new Set<string>((JSON.parse(z.text('Metadata/slicerx_history.json')!) as { bodies: { object: string }[] }).bodies.map((b) => b.object))
  return [...parseHistories(files, ids).values()][0]!
}

describe('suppressing a step that takes parts away', () => {
  it('keeps the part a union took in: box A, box B, A joined with B, box C, union off gives A, C and B', async () => {
    const { ok, d, box, steps, names } = await start()
    await box(0, 'A')
    await box(5, 'B')
    await ok('slicerx_geom_boolean', { design: d, op: 'union', part: 0, with_parts: [1] })
    await box(40, 'C')
    expect(names(await steps())).toEqual(['A', 'C'])
    await ok('slicerx_design_edit_step', { design: d, step: 3, suppressed: true })
    const after = await steps()
    expect(names(after)).toEqual(['A', 'C', 'B'])
    expect((after['steps'] as { state: string }[]).map((s) => s.state)).toEqual(['done', 'done', 'suppressed', 'done'])
    // every part's line says how it was made, none "made outside the history"
    const forms = after['forms'] as string[]
    expect(forms).toHaveLength(3)
    expect(forms[0]).toMatch(/^A: box/)
    expect(forms[1]).toMatch(/^C: box/)
    expect(forms[2]).toMatch(/^B: box/)
    expect(forms.join('\n')).not.toContain('made outside the history')
  })

  it('turning the union back on gives the parts as they were', async () => {
    const { ok, d, box, steps, names } = await start()
    await box(0, 'A')
    await box(5, 'B')
    await ok('slicerx_geom_boolean', { design: d, op: 'union', part: 0, with_parts: [1] })
    await box(40, 'C')
    const was = (await steps())['parts'] as Part[]
    await ok('slicerx_design_edit_step', { design: d, step: 3, suppressed: true })
    expect(names(await steps())).toEqual(['A', 'C', 'B'])
    await ok('slicerx_design_edit_step', { design: d, step: 3, suppressed: false })
    const back = await steps()
    expect(names(back)).toEqual(['A', 'C'])
    expect((back['parts'] as Part[]).map((p) => p.sizeMm.map(round))).toEqual(was.map((p) => p.sizeMm.map(round)))
    expect((back['forms'] as string[]).join('\n')).not.toContain('made outside the history')
  })

  // The record of why a turned-off step keeps numbering the parts, and why a new body is not simply always added at the
  // end. With every new body added at the end, B and E would come back too, but in the order A, B, E, C, D: the join
  // below, made on part 2 when part 2 was D, would land on E. Here D keeps number 2, so its join stays on D, and B and E
  // come back after the numbered parts. Do not "simplify" the numbering into always adding at the end.
  it('keeps a later step on the part it was made on: A, B, E united, C, D, a join on D; union off gives A, C, D, B, E', async () => {
    const { ok, d, box, steps, names } = await start()
    await box(0, 'A')
    await box(5, 'B')
    await box(-5, 'E')
    await ok('slicerx_geom_boolean', { design: d, op: 'union', part: 0, with_parts: [1, 2] })
    await box(40, 'C')
    await box(80, 'D')
    // a 4 mm block 5 mm tall on top of part 2, D
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, placement: { center: [80, 0] }, distance_mm: 5, operation: 'join', part: 2 })
    const before = await steps()
    expect(names(before)).toEqual(['A', 'C', 'D'])
    expect(round((before['parts'] as Part[])[2]!.sizeMm[2])).toBe(15)
    await ok('slicerx_design_edit_step', { design: d, step: 4, suppressed: true })
    const after = await steps()
    expect(names(after)).toEqual(['A', 'C', 'D', 'B', 'E'])
    expect((after['steps'] as { state: string }[]).map((s) => s.state)).toEqual(['done', 'done', 'done', 'suppressed', 'done', 'done', 'done'])
    const parts = after['parts'] as Part[]
    // the join is on D, 15 mm tall; B and E are the plain 10 mm blocks
    expect(parts.map((p) => round(p.sizeMm[2]))).toEqual([10, 10, 15, 10, 10])
    const forms = after['forms'] as string[]
    expect(forms.join('\n')).not.toContain('made outside the history')
    expect(forms[3]).toMatch(/^B: box/)
    expect(forms[4]).toMatch(/^E: box/)
    await ok('slicerx_design_edit_step', { design: d, step: 4, suppressed: false })
    expect(names(await steps())).toEqual(['A', 'C', 'D'])
  })

  it('reads the step that made each part as replay numbers the parts, so a part is lifted at its own step', async () => {
    const { ok, d, box } = await start()
    await box(0, 'A')
    await box(5, 'B')
    await ok('slicerx_geom_boolean', { design: d, op: 'union', part: 0, with_parts: [1] })
    await box(40, 'C')
    const h = savedHistory((await ok('slicerx_design_save', { design: d })).output['path'] as string)
    const made = async (history: History) => {
      const r = await replayHistory((op, request) => geom.engine(op, request), { history })
      const design = { id: 'd', name: 'Blocks', history, parts: r.parts, status: r.status, transform: [...IDENTITY], madeBy: {} } as unknown as Design
      return r.parts.map((p, k) => [p.name, maker(design, k)])
    }
    // C is made by step 4, not by step 2, which made B
    expect(await made(h)).toEqual([['A', 1], ['C', 4]])
    expect(await made({ ...h, steps: h.steps.map((s, i) => (i === 2 ? { ...s, suppressed: true } : s)) })).toEqual([['A', 1], ['C', 4], ['B', 2]])
  })

  it('a saved design reopens with the same parts, and the union turns back on there', async () => {
    const { ok, d, box, steps, names } = await start()
    await box(0, 'A')
    await box(5, 'B')
    await ok('slicerx_geom_boolean', { design: d, op: 'union', part: 0, with_parts: [1] })
    await box(40, 'C')
    await ok('slicerx_design_edit_step', { design: d, step: 3, suppressed: true })
    const here = (await steps())['parts'] as Part[]
    expect(here.map((p) => p.name)).toEqual(['A', 'C', 'B'])
    const saved = (await ok('slicerx_design_save', { design: d })).output['path'] as string
    expect(readFileSync(saved).length).toBeGreaterThan(0)
    const opened = (await ok('slicerx_design_open', { path: saved })).output['designs'] as { id?: string; design?: string }[]
    const last = opened[opened.length - 1]!
    const d2 = (last.id ?? last.design)!
    const there = await steps(d2)
    expect(names(there)).toEqual(['A', 'C', 'B'])
    expect((there['parts'] as Part[]).map((p) => p.sizeMm.map(round))).toEqual(here.map((p) => p.sizeMm.map(round)))
    expect((there['forms'] as string[]).join('\n')).not.toContain('made outside the history')
    await ok('slicerx_design_edit_step', { design: d2, step: 3, suppressed: false })
    expect(names(await steps(d2))).toEqual(['A', 'C'])
  })
})
