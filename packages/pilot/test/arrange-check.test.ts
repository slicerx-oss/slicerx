// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The arrange skill on a project with heimdall's plate check: the layout it made is checked, and a pair a slice would
// still be refused for comes back as leftSure with the plate's fixes. Arrange stops there; it tries no other layout.
import type { PilotMachine } from '@slicerx/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { createScriptedClient } from '../src/provider/scripted'
import type { PlateCheckSummary } from '../src/project'
import type { PilotTool, ToolContext } from '../src/tool'
import { createArrange } from '../skills/arrange/index'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }

function setup(plateCheck?: (plate: number) => Promise<PlateCheckSummary | null>) {
  const env = createEvalEnv({ client: createScriptedClient([]), machine: MACHINE, objects: [{ id: 'o1', name: 'Block', bboxMm: [20, 20, 10] }] })
  const project = plateCheck ? Object.assign(env.project, { plateCheck }) : env.project
  const raw = createArrange({ slices: new Map() } as never) as unknown as PilotTool<Record<string, unknown>>
  const tool: PilotTool<Record<string, unknown>> = { ...raw, run: (i, c) => raw.run(raw.input.parse(i) as Record<string, unknown>, c) }
  const ctx = (): ToolContext => ({ host: { printers: env.sim }, sessionId: 's1', callId: 'c1', signal: new AbortController().signal, context: { machine: MACHINE }, today: '2026-10-30', project, kb: env.kb, progress: () => undefined })
  return { tool, ctx }
}

const left: PlateCheckSummary = {
  clean: false,
  leftSure: [{ a: { id: 'o1', name: 'Block' }, b: { id: 'o1-2', name: 'Block 2' }, collisions: [0] }],
  fixes: [{ kind: 'by_layer', costS: 12, clears: [0], oneClick: true }],
  certainty: ['sure'],
}

describe('arrange with the plate check', () => {
  it('checks each plate it laid out and returns the pairs still sure to clash, with the fixes', async () => {
    const plateCheck = vi.fn(async () => left)
    const { tool, ctx } = setup(plateCheck)
    const out = await tool.run({ printerModel: 'P1S', count: 4 }, ctx())
    expect(plateCheck).toHaveBeenCalledWith(1)
    expect(out.output).toMatchObject({ check: [{ plate: 1, ...left }], leftSure: [{ plate: 1, a: { id: 'o1' }, b: { id: 'o1-2' } }] })
    expect(out.summary).toMatch(/Block and Block 2 on plate 1 would still be refused/)
    // It stops: one check, no second layout.
    expect(plateCheck).toHaveBeenCalledTimes(1)
  })

  it('says nothing more when the layout is clean, and leaves a project without the check as it was', async () => {
    const clean = setup(async () => ({ clean: true, leftSure: [], fixes: [] }))
    const ok = await clean.tool.run({ printerModel: 'P1S', count: 4 }, clean.ctx())
    expect(ok.output).toMatchObject({ leftSure: [] })
    expect(ok.summary).not.toMatch(/refused/)
    const none = setup()
    const plain = await none.tool.run({ printerModel: 'P1S', count: 4 }, none.ctx())
    expect(plain.output).not.toHaveProperty('check')
    // A plate the host does not check (by layer) adds nothing either.
    const byLayer = setup(async () => null)
    expect((await byLayer.tool.run({ printerModel: 'P1S', count: 4 }, byLayer.ctx())).output).not.toHaveProperty('check')
  })
})
