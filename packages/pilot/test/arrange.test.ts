// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The arrange skill on a delta printer's round bed (the FLSUN V400, a 300 mm circle): copies are packed inside the
// circle, not its square box, and the fit check judges the footprint by the circle.
import type { PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { createScriptedClient } from '../src/provider/scripted'
import type { PilotTool, ToolContext } from '../src/tool'
import { buildVolume } from '../skills/common'
import { circleCells, createArrange, fitGrid } from '../skills/arrange/index'

const MACHINE: PilotMachine = { printer: 'flsun_v400', material: 'pla', nozzle: 0.4 }

function setup(bboxMm: [number, number, number]) {
  const env = createEvalEnv({ client: createScriptedClient([]), machine: MACHINE, objects: [{ id: 'o1', name: 'Block', bboxMm }] })
  const raw = createArrange({ slices: new Map() } as never) as unknown as PilotTool<Record<string, unknown>>
  const tool: PilotTool<Record<string, unknown>> = { ...raw, run: (i, c) => raw.run(raw.input.parse(i) as Record<string, unknown>, c) }
  const ctx = (): ToolContext => ({
    host: { printers: env.sim },
    sessionId: 's1',
    callId: 'c1',
    signal: new AbortController().signal,
    context: { machine: MACHINE },
    today: '2026-09-30',
    project: env.project,
    kb: env.kb,
    progress: () => undefined,
  })
  return { env, tool, ctx }
}

describe('arrange on the FLSUN V400', () => {
  it('reads a round 300 mm bed from the knowledge base', () => {
    const { env } = setup([40, 40, 10])
    expect(buildVolume(env.kb, 'FLSUN V400')).toMatchObject({ x: 300, y: 300, z: 410, round: true, source: 'flsun_v400' })
  })

  it('packs copies so every one sits whole inside the circle', async () => {
    const { env, tool, ctx } = setup([40, 40, 10])
    const vol = buildVolume(env.kb, 'FLSUN V400')!
    const cells = circleCells(300, 40, 40, 6)
    for (const [cx, cy] of cells) expect(Math.hypot(Math.abs(cx) + 20, Math.abs(cy) + 20)).toBeLessThanOrEqual(150)
    // The square box would take 6 by 6; the circle holds fewer.
    expect(fitGrid({ x: 300, y: 300, z: 410 }, 40, 40, 6).perPlate).toBe(36)
    const per = fitGrid(vol, 40, 40, 6).perPlate
    expect(per).toBe(cells.length)
    expect(per).toBeLessThan(36)
    expect(per).toBeGreaterThan(16)

    const out = await tool.run({ printerModel: 'FLSUN V400', count: 36 }, ctx())
    expect(out.ok).toBe(false)
    expect(out.summary).toBe(`Only ${per} of 36 fit on 1 plates. Add plates or printers.`)
    const full = await tool.run({ printerModel: 'FLSUN V400', count: per, plates: 1 }, ctx())
    expect(full.ok).not.toBe(false)
    expect(env.project.plates()).toEqual([{ index: 1, items: [{ objectId: 'o1', copies: per }] }])
  })

  it('reports a part whose box fits the square but not the circle as too big', async () => {
    const { tool, ctx } = setup([250, 250, 20])
    const out = await tool.run({ printerModel: 'FLSUN V400', checkFit: true }, ctx())
    expect(out.output).toMatchObject({ fits: false, buildVolume: { round: true } })
    expect(out.summary).toMatch(/^Over the FLSUN V400 by 54 mm in X and Y$/)
    const small = await tool.run({ printerModel: 'FLSUN V400', checkFit: true }, setup([200, 200, 20]).ctx())
    expect(small.output).toMatchObject({ fits: true })
  })
})
