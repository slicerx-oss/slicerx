// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan approved in the mimir tab outlives the session: the scripted mounting plate is built as far as its plate,
// the project is saved, everything mimir held is forgotten (as a restart does), and the project is opened again. The
// plan is back in the tab's registry, tied to the plate as it opened, so design.check finds it (it used to say "there
// is no plan"), and "keep going" in a new chat builds the screw holes the plan still needs and checks the part. The
// file with the plans part still opens the same through both project readers, the engine's and the TypeScript one,
// neither of which knows the part. The browser journey is mimir-plan-restored.spec.ts. Runs on the geometry engine
// (live wasm when built, recorded replies otherwise).
import type { Host, MeshHandle, MeshPart, PilotEvent } from '@slicerx/contracts'
import { tabToolset } from '@slicerx/mcp/toolset'
import { PLAN_LEFT_CODE } from '@slicerx/pilot'
import { PLANS_PART } from '@slicerx/threemf/project'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { sx3mfBytes } from '../src/export/actions'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { unzipEntries } from '../src/export/unzip'
import { zipCompressed } from '../src/export/zip'
import { allPlates } from '../src/plate/plates'
import { clearProject } from '../src/project/new'
import { openModelBytes } from '../src/state/actions'
import { get, set } from '../src/state/store'
import { forgetPlanState, standingPlan, withPlanState } from '../src/workspaces/mimir/plan-state'
import { cardPlans } from '../src/workspaces/mimir/plan-tool'
import { mimirPlans } from '../src/workspaces/mimir/plans'
import { scriptedMimir } from '../src/workspaces/mimir/scripted'
import { SCRIPTS } from '../src/workspaces/mimir/scripts'
import { useGeomEngine } from './geom-engine'

useGeomEngine('mimir-plan-restored-replies', { compressed: true })

const PLAN_ID = 'plan_mount'
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [80, 50, 4], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ ...handle(name), parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) } } as unknown as Host
const tools = () => withPlanState(tabToolset(appDesignHost(loader), cardPlans, { nozzleMm: () => 0.4, newPlanId: () => PLAN_ID }))

/** One message to the scripted tab mimir in a new chat, its sheet confirmed as shown and its plan card answered Go. */
async function say(message: string): Promise<PilotEvent[]> {
  const p = scriptedMimir(SCRIPTS, tools(), { standingPlan })
  const events: PilotEvent[] = []
  for await (const e of p.run('s', message)) {
    events.push(e)
    if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, {})
    if (e.type === 'ask') void p.answer!(e.askId, e.choices.find((c) => c.id.startsWith('go:'))?.id ?? null)
  }
  return events
}

const notices = (events: PilotEvent[]) => events.filter((e) => e.type === 'error' && e.code === PLAN_LEFT_CODE)
const text = (events: PilotEvent[]) => events.map((e) => (e.type === 'text' ? e.delta : '')).join('')
const calls = (events: PilotEvent[]) => events.flatMap((e) => (e.type === 'tool_call' ? [e.tool] : []))
const plate = () => get().plate.map((e) => ({ name: e.name, steps: e.history?.steps.map((s) => s.feature ?? null) ?? [] }))
const asBuffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** Everything mimir held in memory goes, as when the app is closed: the plans, the plan state and the plate. */
function restart(): void {
  cardPlans.clearPlans()
  forgetPlanState()
  clearProject()
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null })
}

/** The mounting plate built as far as its plate, then saved: the project file's bytes. */
async function halfBuiltSaved(): Promise<Uint8Array> {
  const events = await say('Make a mounting plate, just the plate for now')
  expect(text(events)).toContain('Which screws will hold it, M4 or M3?')
  expect(notices(events)).toEqual([])
  expect(plate()).toEqual([{ name: 'Mounting plate', steps: ['Plate'] }])
  return sx3mfBytes(allPlates(get()), { settings: {} })
}

/** design.check of the plan through the tab's tools, as mimir or an MCP client over the app link calls it. */
async function check(): Promise<{ ok: boolean; summary: string; output?: { planId: string; design: string; pass: boolean } }> {
  const tool = tools().find((t) => t.name === 'design.check')!
  try {
    const out = await tool.run(tool.input.parse({ planId: PLAN_ID }) as never, {} as never)
    return { ok: out.ok !== false, summary: out.summary, output: out.output as never }
  } catch (e) {
    return { ok: false, summary: (e as Error).message }
  }
}

beforeEach(() => {
  // step ids carry the time, and the saved file carries them into what the engine reads, so the clock is fixed
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-09T00:00:00Z'))
  restart()
})
afterEach(() => {
  vi.useRealTimers()
  readProjectsWithGeom(true)
  restart()
})

describe('a mounting plate half built, saved and opened again', () => {
  it('has its plan back, tied to the plate as it opened, with the step ids mimir left', async () => {
    const bytes = await halfBuiltSaved()
    const files = await unzipEntries(bytes)
    const part = JSON.parse(new TextDecoder().decode(files.get(PLANS_PART)!)) as { version: number; last: string; plans: { plan: { planId: string }; design: string; steps: string[] }[] }
    expect(part.version).toBe(1)
    expect(part.last).toBe(PLAN_ID)
    expect(part.plans.map((p) => p.plan.planId)).toEqual([PLAN_ID])
    // plan state only: nothing the person said, no prompt
    expect(JSON.stringify(part)).not.toMatch(/just the plate|User request|Which screws/)
    const stepIds = get().plate[0]!.history!.steps.map((s) => s.id)
    expect(part.plans[0]!.steps).toEqual(stepIds)
    restart()
    expect(mimirPlans.get(PLAN_ID)).toBeUndefined()
    await openModelBytes(host, 'mounting plate.sx3mf', asBuffer(bytes), undefined, { fresh: true })
    const opened = get().plate
    expect(opened.map((e) => e.name)).toEqual(['Mounting plate'])
    expect(mimirPlans.get(PLAN_ID)).toMatchObject({ origin: 'card', design: opened[0]!.id, plan: { planId: PLAN_ID, part: 'Mounting plate' } })
  })

  it('design.check finds the plan after the reopen, where it used to say there is no plan', async () => {
    const bytes = await halfBuiltSaved()
    restart()
    // what a restart left before: the planId mimir and the person still have names nothing
    expect((await check()).summary).toContain(`there is no plan ${PLAN_ID}`)
    await openModelBytes(host, 'mounting plate.sx3mf', asBuffer(bytes), undefined, { fresh: true })
    const out = await check()
    expect(out.ok).toBe(true)
    expect(out.output).toMatchObject({ planId: PLAN_ID, design: get().plate[0]!.id, pass: false })
    // the plate is there, the screw holes are not yet
    expect(out.summary).toContain('Screw holes')
  })

  it('"keep going" in a new chat builds the screw holes the plan still needs and checks the part', async () => {
    const bytes = await halfBuiltSaved()
    restart()
    await openModelBytes(host, 'mounting plate.sx3mf', asBuffer(bytes), undefined, { fresh: true })
    const events = await say('keep going')
    expect(notices(events)).toEqual([expect.objectContaining({ message: 'mimir went on to the parts the plan still needs: Screw holes.' })])
    expect(calls(events)).toEqual(['geom.extrude', 'design.check'])
    expect(events.filter((e) => e.type === 'tool_result' && !e.ok)).toEqual([])
    expect(text(events)).toContain('Done: the mounting plate, 80 x 50 x 4 mm with four 4.5 mm screw holes. It matches the plan.')
    expect(plate()).toEqual([{ name: 'Mounting plate', steps: ['Plate', 'Screw holes'] }])
    // passed: a later chat gets no plan to go on with
    expect(standingPlan()).toBeUndefined()
  })

  it('opens the same through both project readers, which leave the plans part alone', async () => {
    const withPart = await halfBuiltSaved()
    const entries = await unzipEntries(withPart)
    expect(entries.has(PLANS_PART)).toBe(true)
    // the same file without the part, as a project saved with no plan open is
    const without = await zipCompressed([...entries].filter(([name]) => name !== PLANS_PART).map(([name, data]) => ({ name, data })))
    const bed = { widthMm: 256, depthMm: 256 }
    /** What a reader that does not know the part opens: everything but the plans. */
    const opened = (p: Awaited<ReturnType<typeof readProject>>) => ({
      objects: p.plates.map((pl) => pl.objects.map((o) => ({ name: o.name, transform: o.transform, parts: o.parts.map((m) => [m.name, m.positions.length, m.indices.length]) }))),
      histories: [...p.histories].map(([id, h]) => [id, h.steps.map((st) => [st.id, st.feature ?? null])]),
      timeline: p.timeline ?? null,
      namedValues: p.namedValues,
      notes: [p.historyNote, p.settingsNote, p.readerNote],
    })
    for (const geom of [true, false]) {
      readProjectsWithGeom(geom)
      const a = await readProject(withPart, bed)
      const b = await readProject(without, bed)
      expect(a.plans?.plans.map((p) => (p.plan as { planId: string }).planId)).toEqual([PLAN_ID])
      expect(b.plans).toBeUndefined()
      expect(opened(a).objects).toEqual([[expect.objectContaining({ name: 'Mounting plate' })]])
      expect(opened(a)).toEqual(opened(b))
    }
  })
})
