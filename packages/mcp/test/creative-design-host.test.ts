// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval builds parts with the mimir tab's design tools on a design host of its own: the designs in memory,
// each step replayed on the geometry engine as CAD history. A part built through design.new and geom.extrude replays
// from its history alone to the same body, and a recorded reply that builds with the design tools replays through the
// eval and is scored on that body.
import { replayHistory } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { headlessDesignHost } from '../evals/creative/design-host'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { parseRecording } from '../evals/creative/recordings'
import { runPrompt } from '../evals/creative/run'
import { createCardPlans, createPlanRegistry, tabToolset } from '../src/toolset'
import { useGeomEngine } from './geom-engine'

const g = useGeomEngine('creative-design-host')
const engine = (op: string, request: unknown) => g.engine(op, request)

const size = (parts: { positions: ArrayLike<number> }[]): number[] => {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) for (let i = 0; i + 2 < p.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k]!, p.positions[i + k]!)
    hi[k] = Math.max(hi[k]!, p.positions[i + k]!)
  }
  return hi.map((h, k) => Math.round((h - lo[k]!) * 100) / 100)
}

const call = async (tools: ReturnType<typeof tabToolset>, name: string, input: unknown) => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.run(input as never, {} as never)
}

describe('the creative eval design host', () => {
  it('builds a part through the design tools as feature history, and the history replays to the same body', async () => {
    const host = headlessDesignHost(engine)
    const tools = tabToolset(host, createCardPlans(createPlanRegistry()), { nozzleMm: () => 0.4 })
    const made = (await call(tools, 'design.new', { name: 'Block' })) as { output: { design: string } }
    expect(made.output.design).toBe('d1')
    await call(tools, 'geom.extrude', { design: 'd1', shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 5 })
    await call(tools, 'geom.extrude', { design: 'd1', shape: { type: 'circle', diameterMm: 4 }, distance_mm: 5, operation: 'cut' })
    const d = host.get('d1')
    expect(d.history.steps.map((s) => s.params.op)).toEqual(['shape.extrude', 'shape.extrude'])
    expect(d.status.map((s) => s.state)).toEqual(['done', 'done'])
    expect(size(d.parts)).toEqual([20, 10, 5])
    // the history alone, replayed again, is the same body
    const again = await replayHistory(engine, { history: d.history })
    expect(again.status.every((s) => s.state === 'done')).toBe(true)
    expect(size(again.parts)).toEqual(size(d.parts))
    expect(again.parts.reduce((n, p) => n + p.indices.length, 0)).toBe(d.parts.reduce((n, p) => n + p.indices.length, 0))
    // counted ids, so a recorded reply names the same design, steps and revisions on replay
    expect(d.history.steps.map((s) => s.id)).toEqual([`s${Date.parse('2026-09-30T14:00:00Z').toString(36)}1`, `s${Date.parse('2026-09-30T14:00:00Z').toString(36)}2`])
    expect(host.revision?.('d1')).toBe('d1:3')
  })
})

describe('a recorded reply that builds with the design tools', () => {
  const P = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
  const recorded = parseRecording(
    JSON.stringify({
      status: 'recorded',
      model: 'scripted',
      provider: 'scripted',
      capturedAt: '2026-11-07T00:00:00Z',
      tabTools: true,
      defaultAnswer: true,
      steps: [
        // the tab builds nothing before the person confirms the sizes on a sheet
        { calls: [{ name: 'pilot.sheet', args: { title: 'Tray size', dims: [{ key: 'length', label: 'Length', value: 100, unit: 'mm', source: 'guess' }] } }] },
        { calls: [{ name: 'design.new', args: { name: 'Cable organizer' } }] },
        { calls: [{ name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 100, heightMm: 30 }, distance_mm: 20 } }] },
        { calls: [{ name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 96, heightMm: 26 }, placement: { center: [0, 0] }, frame: { origin: [0, 0, 20], normal: [0, 0, 1] }, distance_mm: 18, operation: 'cut' } }] },
        { text: 'Built a 100 by 30 by 20 mm tray with 2 mm walls.' },
      ],
    }),
  )

  it('replays through the eval on the tab tools and is scored on the body it built', async () => {
    if (recorded.status !== 'recorded') throw new Error('recorded')
    const run = await runPrompt(P, { geom: { run: (op, input) => engine(op, input) }, steps: recorded.steps, answerRecorded: true, tabTools: true })
    expect(run.error).toBeUndefined()
    expect(run.stale).toBeUndefined()
    expect(run.calls).toEqual(['pilot.sheet', 'design.new', 'geom.extrude', 'geom.extrude'])
    expect(run.noBuild).toBeUndefined()
    expect(run.parsed.pass).toBe(true)
    expect(run.parsed.detail).toMatch(/1 design, 2 feature steps/)
    expect(size(run.parts)).toEqual([100, 30, 20])
  })

  it('marks a recording from before the tab tools stale', async () => {
    if (recorded.status !== 'recorded') throw new Error('recorded')
    const run = await runPrompt(P, { geom: undefined, steps: [{ calls: [{ name: 'text_to_part', args: { prompt: 'a tray' } }] }, { text: 'Done.' }], answerRecorded: true })
    expect(run.stale).toMatch(/design tools/)
    expect(run.calls).toEqual(['text_to_part'])
  })
})
