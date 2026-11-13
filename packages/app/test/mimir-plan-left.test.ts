// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab's scripted mounting plate: its sheet is confirmed and its plan gets Go, the plate is built, and the reply
// stops to ask whether to add the screw holes the plan already has. mimir goes on once instead, with one line in the
// chat that says so, then builds the holes tagged with their feature and checks the part against its plan. The browser
// journey (phone-mimir-plan-left.spec.ts, desktop and phone) shows that line on screen; this runs the same script on
// the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart, PilotEvent } from '@slicerx/contracts'
import { tabToolset } from '@slicerx/mcp/toolset'
import { PLAN_LEFT_CODE } from '@slicerx/pilot'
import { beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { get, set } from '../src/state/store'
import { cardPlans } from '../src/workspaces/mimir/plan-tool'
import { scriptedMimir } from '../src/workspaces/mimir/scripted'
import { SCRIPTS } from '../src/workspaces/mimir/scripts'
import { useGeomEngine } from './geom-engine'

useGeomEngine('mimir-plan-left-replies', { compressed: true })

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

/** The script for `message`, with its sheet confirmed as shown and the plan card answered by `pick` (Go unless said). */
async function run(message: string, pick: 'go' | 'change' = 'go'): Promise<PilotEvent[]> {
  const p = scriptedMimir(SCRIPTS, tabToolset(appDesignHost(loader), cardPlans, { nozzleMm: () => 0.4 }))
  const events: PilotEvent[] = []
  for await (const e of p.run('s', message)) {
    events.push(e)
    if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, {})
    if (e.type === 'ask') void p.answer!(e.askId, e.choices.find((c) => c.id.startsWith(`${pick}:`))?.id ?? null)
  }
  return events
}

const notices = (events: PilotEvent[]) => events.filter((e): e is Extract<PilotEvent, { type: 'error' }> => e.type === 'error' && e.code === PLAN_LEFT_CODE)
const text = (events: PilotEvent[]) => events.map((e) => (e.type === 'text' ? e.delta : '')).join('')

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))

describe('the scripted mounting plate', () => {
  it('goes on once to the screw holes its approved plan still needs, with one line that says so', async () => {
    const events = await run('Make a mounting plate')
    const left = notices(events)
    expect(left).toHaveLength(1)
    expect(left[0]!.message).toBe('mimir went on to the parts the plan still needs: Screw holes.')
    expect(left[0]!.waiting).toBe(true)
    // the reply that stopped, then the holes and the check after the note
    const said = text(events)
    expect(said).toContain('Should I add the screw holes next?')
    expect(said).toContain('Adding the four screw holes from the plan.')
    expect(events.filter((e) => e.type === 'tool_result' && !e.ok)).toEqual([])
    const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.tool] : []))
    expect(calls).toEqual(['pilot.sheet', 'design.plan', 'design.new', 'geom.extrude', 'geom.extrude', 'design.check'])
    expect(said).toContain('Done: the mounting plate, 80 x 50 x 4 mm with four 4.5 mm screw holes. It matches the plan.')
    expect(get().plate.map((e) => ({ name: e.name, steps: e.history?.steps.length ?? 0 }))).toEqual([{ name: 'Mounting plate', steps: 2 }])
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
    // the screw hole count stays with its diameter in holes, which the card shows as 4 x 4.5 mm, never as a size in mm
    const plan = events.find((e): e is Extract<PilotEvent, { type: 'tool_call' }> => e.type === 'tool_call' && e.tool === 'design.plan')
    const args = plan!.input as { features: { sizes: Record<string, number> }[]; holes?: unknown }
    expect(args.features.flatMap((f) => Object.keys(f.sizes))).not.toContain('count')
    expect(args.holes).toEqual([{ name: 'Screw holes', diameter: 4.5, count: 4 }])
  })

  it('a late Not yet on a plan that went ahead changes nothing; the plate is built', async () => {
    // at its default size the plan is approved as shown with nobody asked: a Not yet sent after
    // it is no answer the run takes
    const events = await run('Make a mounting plate', 'change')
    expect(events.find((e) => e.type === 'ask_answered')).toMatchObject({ auto: true })
    expect(text(events)).not.toContain('Okay, nothing is built.')
    expect(text(events)).toContain('Done: the mounting plate, 80 x 50 x 4 mm with four 4.5 mm screw holes. It matches the plan.')
    expect(get().plate.map((e) => ({ name: e.name, steps: e.history?.steps.length ?? 0 }))).toEqual([{ name: 'Mounting plate', steps: 2 }])
  })
})
