// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir build evals: seventeen parts asked for in one message, most needing a loft or a sweep, four boxy controls and
// a planter with its saucer asked for as two parts, run through the tab exactly as the desktop app makes it
// (test/mimir-build-evals/drive.ts) and scored on the part and on the person's turns (score.ts). By default this checks
// the scoring, and replays offline each case that has a recording in test/mimir-build-evals/recordings (a case without
// one skips until a live run records it); a replay needs the geometry engine (packages/geom/wasm/scripts/build.sh) and
// skips without it. The lofted vases replay only with SX_SLOW_EVALS=1, since their shells are slow to rebuild.
//
// A live run asks the model and records nothing unless told to:
//   SX_MIMIR_EVAL=live [SX_MIMIR_EVAL_CASES=id,id] [SX_MIMIR_EVAL_CAP=0.50] [SX_MIMIR_EVAL_RECORD=1]
//   [SX_MIMIR_EVAL_OUT=results.jsonl] [SX_MIMIR_EVAL_LABEL=what changed] vitest run test/mimir-build-evals.test.ts
// with ANTHROPIC_API_KEY in the environment. It runs on Haiku unless SX_MIMIR_EVAL_MODEL names another model with a
// price (drive.ts EVAL_PRICES: claude-sonnet-5-5), at mimir cloud's rates; no new request starts once the spend reaches
// the cap less the stop margin, and no case starts past it. Recording stays on Haiku: recordings are kept one per case,
// so a run on another model would replace the Haiku one.
//
// A replay's stored score is kept as recorded. SX_MIMIR_EVAL_UPDATE_SCORES=1 only fills fields a recording lacks. After a
// scorer change moves a stored score, SX_MIMIR_EVAL_RESCORE=1 with SX_MIMIR_EVAL_RESCORE_REASON="which change" writes
// each clean replay's score over the stored one and logs a RESCORE line per case with every field it moved; a replay
// that diverged fails, and its recording is captured again instead.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { MeshPart, PilotEvent } from '@slicerx/contracts'
import { createTransportClient, type LlmMessage } from '@slicerx/pilot'
import { createNodeTransport } from '@slicerx/pilot/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { budgetedClient, canStart, createBudget, HAIKU_5_5, STOP_MARGIN_USD } from '../../mcp/evals/creative/live'
import { minWall as engineWall } from '../../mcp/src/body-facts'
import { setGeomProvider } from '../src/geom/client'
import { finishSketch } from '../src/cad/sketches'
import { get } from '../src/state/store'
import { liveEngine, wasmGeom } from './geom-engine'
import { BUILD_CASES } from './mimir-build-evals/cases'
import { driveCase, EVAL_MODEL, evalPrice, replaySteps, SONNET_5_5, tabConfig, type CaseRun } from './mimir-build-evals/drive'
import { loadRecording, recordLive, refreshScore, rescore, rescoreLine, scoreMoves, summarize } from './mimir-build-evals/recordings'
import { assemblySizes, checkCalls, checkFromCalls, classifyNoBuild, extraTurns, floorCheck, hingeCheck, hookCheck, lastCheckPass, lidStated, okSteps, replyClaim, runClaim, scoreCase, verdictCounts, verdictOf, type UserTurn } from './mimir-build-evals/score'

const live = process.env['SX_MIMIR_EVAL'] === 'live'

const summary = (r: CaseRun) => summarize(r.score)
/** A replay's own limit on the drive, just under the 180 s the test is given, so a stalled replay fails with its error and not as a vitest timeout. */
const REPLAY_DRIVE_MS = 170_000

describe('build eval scoring', () => {
  it('carries a sketch id with no digit from this run into the next call, as it does one with a digit', () => {
    const made = (id: string) => JSON.stringify({ ok: true, summary: 'Sketch 1 is in the timeline', result: { id, name: 'Sketch 1', loops: 1 } })
    const [step] = replaySteps([{ seen: [made('smwapacdb1k')], calls: [{ name: 'geom.extrude', args: { sketch: 'smwapacdb1k', distance_mm: 80 } }] }])
    if (typeof step !== 'function') throw new Error('a replayed step reads the results before it')
    for (const now of ['smwatqzbcak', 'smwatqz9bck']) {
      const asked: LlmMessage[] = [
        { role: 'user', content: 'a phone stand' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'design.sketch', arguments: '{}' }] },
        { role: 'tool', callId: 'c0', content: made(now) },
      ]
      expect(step(asked).calls).toEqual([{ name: 'geom.extrude', args: { sketch: now, distance_mm: 80 } }])
    }
  })

  it('reads a reply that turns the headphone stand down as turning the part down', () => {
    expect(classifyNoBuild('The curved hook and tapered hollow stem need a swept path and a loft, which this modeler cannot create. I can stack faceted sections instead. Want that?')).toBe('declined')
    expect(classifyNoBuild('What height should the stand be?')).toBe('asked')
    expect(classifyNoBuild('Built the stand.')).toBe('none')
  })

  it('lets one message, one sheet confirm and one Go through, and counts everything else', () => {
    const turns: UserTurn[] = [
      { kind: 'message', text: 'a stand' },
      { kind: 'sheet', title: 'Sizes' },
      { kind: 'go', part: 'Build it?', plan: 'p1', design: 'd1' },
    ]
    expect(extraTurns(turns)).toEqual([])
    const more: UserTurn[] = [...turns, { kind: 'sheet', title: 'Sizes' }, { kind: 'answer', question: 'Which base?', picked: 'Round' }, { kind: 'nudge', text: 'go', why: 'asked' }]
    expect(extraTurns(more).map((t) => t.kind)).toEqual(['sheet', 'answer', 'nudge'])
  })

  it('lets one Go on a change to an approved plan through as a plan change, and counts a second', () => {
    // the cable hook run that fixed its plan's overall size with amends after its check failed (live, 11-10)
    const turns: UserTurn[] = [
      { kind: 'message', text: 'a cable hook' },
      { kind: 'sheet', title: 'Cable hook' },
      { kind: 'go', part: 'Build cable hook from this plan?', plan: 'p1', design: 'd1' },
      { kind: 'amend', part: 'Change the cable hook plan?', plan: 'p1', revision: 2, design: 'd1' },
    ]
    expect(extraTurns(turns)).toEqual([])
    const c = BUILD_CASES.find((x) => x.id === 'cable-hook')!
    const scored = scoreCase(c, { events: [], turns, parts: [], firstReply: '', firstBuilt: false, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 })
    expect(scored.turns).toEqual({ pass: true, detail: 'one message, sheet and Go only, and one plan change' })
    // a second change to the same plan is past the one fix round, so it counts; so does a Go on a plan for the same part
    const again: UserTurn = { kind: 'amend', part: 'Change the cable hook plan?', plan: 'p1', revision: 3, design: 'd1' }
    expect(extraTurns([...turns, again])).toEqual([again])
    expect(scoreCase(c, { events: [], turns: [...turns, again], parts: [], firstReply: '', firstBuilt: false, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 }).turns).toEqual({ pass: false, detail: 'another plan change' })
    expect(extraTurns([...turns, { kind: 'go', part: 'Build cable hook from this plan?', plan: 'p2', design: 'd1' }]).map((t) => t.kind)).toEqual(['go'])
  })

  it('counts only steps that ran, and a revolve as partial only under a full turn', () => {
    const events: PilotEvent[] = [
      { type: 'tool_call', callId: 'a', tool: 'geom.loft', source: 'command', input: {} },
      { type: 'tool_result', callId: 'a', ok: false, summary: 'profiles cross', ms: 1 } as PilotEvent,
      { type: 'tool_call', callId: 'b', tool: 'geom.revolve', source: 'command', input: { angle_deg: 90 } },
      { type: 'tool_result', callId: 'b', ok: true, summary: 'Revolved', ms: 1 } as PilotEvent,
    ]
    expect(okSteps(events).map((s) => s.tool)).toEqual(['geom.revolve'])
    const elbow = BUILD_CASES.find((c) => c.id === 'pipe-elbow')!
    const s = scoreCase(elbow, { events, turns: [{ kind: 'message', text: elbow.prompt }], parts: [], firstReply: '', firstBuilt: false, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 })
    expect(s.ops.pass).toBe(true)
    expect(s.built).toBe(false)
    expect(s.pass).toBe(false)
    const bottle = BUILD_CASES.find((c) => c.id === 'square-bottle')!
    expect(scoreCase(bottle, { events, turns: [], parts: [], firstReply: '', firstBuilt: false, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 }).ops.pass).toBe(false)
    // a boxy control built from solids counts as much as one built from extrudes
    const built: PilotEvent[] = [
      { type: 'tool_call', callId: 'c', tool: 'geom.build', source: 'command', input: {} },
      { type: 'tool_result', callId: 'c', ok: true, summary: 'Built', ms: 1 } as PilotEvent,
    ]
    const box = BUILD_CASES.find((c) => c.id === 'hinged-box')!
    expect(scoreCase(box, { events: built, turns: [], parts: [], firstReply: '', firstBuilt: false, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 }).ops.pass).toBe(true)
  })

  it('has the seventeen cases, the headphone stand in the words of the request', () => {
    expect(BUILD_CASES.map((c) => c.id)).toEqual(['headphone-stand', 'square-bottle', 'cable-hook', 'mug-handle', 'twisted-vase', 'pipe-elbow', 'pi5-case', 'hinged-box', 'flared-vase', 'drawer-handle', 'cable-clip', 'phone-stand-lip', 'planter-saucer', 'coat-hook', 'watering-spout', 'tapered-hook', 'duct-transition'])
    expect(BUILD_CASES[0]!.prompt).toBe("Design a headphone stand: a round weighted base, a hollow tapered stem, and a curved hook at the top with a soft lip so the headband doesn't slide off. Ask me for the main sizes first.")
    expect(BUILD_CASES.filter((c) => c.control).map((c) => c.id)).toEqual(['pi5-case', 'hinged-box', 'cable-clip', 'phone-stand-lip'])
    expect(BUILD_CASES.filter((c) => (c.parts ?? 1) > 1).map((c) => c.id)).toEqual(['planter-saucer'])
  })

  it('lets a sheet and a Go through for each part when the request asks for separate parts', () => {
    const planter = BUILD_CASES.find((c) => c.id === 'planter-saucer')!
    const vase = BUILD_CASES.find((c) => c.id === 'flared-vase')!
    // the planter and the saucer, each sized on its own sheet and built after its own Go
    const turns: UserTurn[] = [
      { kind: 'message', text: planter.prompt },
      { kind: 'sheet', title: 'Planter' },
      { kind: 'go', part: 'Build the planter?', plan: 'p1', design: 'd1' },
      { kind: 'sheet', title: 'Saucer' },
      { kind: 'go', part: 'Build the saucer?', plan: 'p2', design: 'd2' },
    ]
    const run = (c: typeof planter, t: UserTurn[]) => scoreCase(c, { events: [], turns: t, parts: [], firstReply: '', firstBuilt: false, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 })
    const two = run(planter, turns)
    expect(two.turns, two.turns.detail).toMatchObject({ pass: true })
    expect(two.extra).toBe(0)
    // a third sheet is past the two parts asked for
    const third = run(planter, [...turns, { kind: 'sheet', title: 'Planter' }])
    expect(third.extra).toBe(1)
    expect(third.turns.detail).toBe('another sheet')
    // a one part request still counts the second sheet and Go
    expect(run(vase, turns).extra).toBe(2)
    expect(extraTurns(turns).map((t) => t.kind)).toEqual(['sheet', 'go'])
  })

  it('frees a sheet only for a part not sized yet, and a Go only for a design not built yet', () => {
    const planter = BUILD_CASES.find((c) => c.id === 'planter-saucer')!
    const run = (t: UserTurn[]) => scoreCase(planter, { events: [], turns: t, parts: [], firstReply: '', firstBuilt: false, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 })
    const message: UserTurn = { kind: 'message', text: planter.prompt }
    // the same sheet and Go twice with two parts, both plans built in one design: the person confirmed the planter twice
    const twice: UserTurn[] = [message, { kind: 'sheet', title: 'Planter' }, { kind: 'go', part: 'Build the planter?', plan: 'p1', design: 'd1' }, { kind: 'sheet', title: 'Planter' }, { kind: 'go', part: 'Build the planter?', plan: 'p2', design: 'd1' }]
    expect(extraTurns(twice, 2).map((t) => t.kind)).toEqual(['sheet', 'go'])
    const scored2 = run(twice)
    expect(scored2.extra).toBe(2)
    expect(scored2.turns.detail).toBe('another sheet, another go')
    // two sheets asked together and two plans built in designs of their own are free up to the parts asked for
    expect(extraTurns([message, { kind: 'sheet', title: 'Planter' }, { kind: 'sheet', title: 'Saucer' }, { kind: 'go', part: 'Build the planter?', plan: 'p1', design: 'd1' }, { kind: 'go', part: 'Build the saucer?', plan: 'p2', design: 'd2' }], 2)).toEqual([])
    // a third Go, even for a new design, is past the two asked for
    const go = (n: string): UserTurn => ({ kind: 'go', part: n, plan: `p${n}`, design: `d${n}` })
    expect(extraTurns([message, go('a'), go('b'), go('c')], 2).map((t) => t.kind)).toEqual(['go'])
    // the boundary: three parts allow three distinct sheets and Gos, and no more
    const three: UserTurn[] = [message, ...['a', 'b', 'c'].flatMap((n): UserTurn[] => [{ kind: 'sheet', title: n }, go(n)])]
    expect(extraTurns(three, 3)).toEqual([])
    expect(extraTurns([...three, { kind: 'sheet', title: 'd' }], 3).map((t) => t.kind)).toEqual(['sheet'])
    expect(extraTurns([...three, go('d')], 3).map((t) => t.kind)).toEqual(['go'])
  })

  it('stops a drive at its own limit and says so, instead of ending quietly', async () => {
    const c = BUILD_CASES.find((x) => x.id === 'cable-clip')!
    // a model that never answers: the stream ends only when the drive aborts it
    const stalled = {
      provider: 'anthropic',
      async *stream(_req: unknown, signal?: AbortSignal) {
        await new Promise<void>((res) => (signal?.aborted ? res() : signal?.addEventListener('abort', () => res())))
      },
    }
    const r = await driveCase(c, { client: stalled as never, timeoutMs: 300 })
    expect(r.error).toMatch(/stopped after 0\.3 s/)
    expect(r.score.built).toBe(false)
  }, 30_000)

  // the cable clip under an id of its own, so these runs' chats stay apart from its replay
  const asCase = (id: string) => ({ ...BUILD_CASES.find((x) => x.id === 'cable-clip')!, id })

  it('says why a run ended when the model fails: the provider\'s error, not a quiet end', async () => {
    const c = asCase('provider-down')
    const down = {
      provider: 'anthropic',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('the provider is down')
      },
    }
    const r = await driveCase(c, { client: down as never, timeoutMs: 20_000 })
    expect(r.error).toMatch(/ended on an error: .*the provider is down/)
    expect(r.score.built).toBe(false)
  }, 30_000)

  it('says the run reached the step cap when the model calls tools until it runs out of steps', async () => {
    const c = asCase('step-cap')
    let n = 0
    // reads the designs on every step and never answers, so only the step cap ends the turn
    const busy = {
      provider: 'anthropic',
      async *stream(req: { toolChoice?: string }) {
        if (req.toolChoice === 'none') yield { type: 'text', delta: 'Still looking.' }
        else yield { type: 'tool_call', call: { id: `c${++n}`, name: 'design.list', arguments: '{}' } }
        yield { type: 'done', stop: req.toolChoice === 'none' ? 'end' : 'tool_calls' }
      },
    }
    const r = await driveCase(c, { client: busy as never, timeoutMs: 20_000 })
    expect(r.error).toMatch(/step cap/)
    expect(n).toBeGreaterThan(10)
  }, 30_000)

  it('says the budget stopped a run, and a stopped run is not saved as a recording', async () => {
    const c = asCase('budget-stop')
    const budget = createBudget(0.5)
    budget.spentUsd = 0.5 - STOP_MARGIN_USD
    let sent = 0
    const base = {
      provider: 'anthropic',
      async *stream() {
        sent++
        yield { type: 'done', stop: 'end' }
      },
    }
    const r = await driveCase(c, { client: budgetedClient(base as never, EVAL_MODEL, HAIKU_5_5, budget), timeoutMs: 20_000 })
    expect(sent).toBe(0)
    expect(budget.stopped).toBe(true)
    expect(r.error).toMatch(/ended on an error: stopped at \$0\.40/)
    const dir = mkdtempSync(join(tmpdir(), 'rec-'))
    try {
      // the run as a live record run sees it: steps, but the budget stopped it (and with no error, the stop alone holds it back)
      const stopped = { ...r, steps: [{ text: 'half a reply' }] }
      delete stopped.error
      expect(recordLive(c.id, stopped, { model: EVAL_MODEL, provider: 'anthropic', stopped: true }, dir)).toBe(false)
      expect(loadRecording(c.id, dir)).toBeNull()
      expect(recordLive(c.id, stopped, { model: EVAL_MODEL, provider: 'anthropic', stopped: false }, dir)).toBe(true)
      expect(loadRecording(c.id, dir)?.steps).toEqual([{ text: 'half a reply' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('fails a replay that leaves recorded replies unused', async () => {
    const c = asCase('leftover-replies')
    // four questions: the message and the two nudges take three, and the fourth is never asked for
    const asks = Array.from({ length: 4 }, (_, i) => ({ text: `Which size, ${i + 1}?` }))
    const r = await driveCase(c, { steps: asks, timeoutMs: 20_000 })
    expect(r.turns.filter((t) => t.kind === 'nudge')).toHaveLength(2)
    expect(r.error).toBe('the replay left 1 recorded reply unused')
    const used = await driveCase(c, { steps: asks.slice(0, 3), timeoutMs: 20_000 })
    expect(used.error).toBeUndefined()
  }, 30_000)

  it('keys a Go on the design its plan built, read from the plan the person approved', async () => {
    const c = asCase('plan-tie')
    const plan = { part: 'cable clip', units: 'mm', features: [{ name: 'base', kind: 'extrude', sizes: { width: 20 } }, { name: 'hook', kind: 'extrude', sizes: { width: 10 } }], assumptions: [], questions: [] }
    const r = await driveCase(c, { steps: [{ calls: [{ name: 'design.plan', args: plan }] }, { calls: [{ name: 'design.new', args: { name: 'Plan tie clip' } }] }, { text: 'Started the clip.' }], timeoutMs: 20_000 })
    const go = r.turns.find((t) => t.kind === 'go')
    expect(go, JSON.stringify(r.calls)).toMatchObject({ kind: 'go', part: 'Build cable clip from this plan?', plan: expect.stringMatching(/^plan_/) })
    expect(go?.kind === 'go' && go.design).toMatch(/^obj_/)
  }, 30_000)

  it('starts each drive with no designs, so two drives can start a design with the same name', async () => {
    const c = asCase('same-name')
    const steps = [{ calls: [{ name: 'design.new', args: { name: 'Twin clip' } }] }, { calls: [{ name: 'design.steps', args: { design: 'Twin clip' } }] }, { text: 'Started it.' }]
    const first = await driveCase(c, { steps, timeoutMs: 20_000 })
    expect(first.calls, JSON.stringify(first.calls)).toEqual(['design.new ok', 'design.steps ok'])
    const second = await driveCase(c, { steps, timeoutMs: 20_000 })
    expect(second.calls, JSON.stringify(second.calls)).toEqual(['design.new ok', 'design.steps ok'])
  }, 30_000)

  it('keeps each design.check call with the plan it named and the items it failed, so two plans in a run stay apart', () => {
    // a run with two plans: the second plan's check passes, a look reads the part, and a check of the first plan fails
    // on its size with no edit between
    const check = (id: string, planId: string, output: unknown, ok = true): PilotEvent[] => [
      { type: 'tool_call', callId: id, tool: 'design.check', source: 'command', input: { planId } },
      { type: 'tool_result', callId: id, ok, summary: ok ? 'checked' : 'planId: there is no plan plan_c', output } as PilotEvent,
    ]
    const items = (sizeOk: boolean) => [
      { name: 'overall size', want: '80 x 50 x 35 mm', got: '80 x 53 x 38 mm', pass: sizeOk },
      { name: 'watertight', want: 'closed', got: 'closed', pass: true },
    ]
    const events = [
      ...check('a', 'plan_b', { design: 'obj_1', pass: true, items: items(true) }),
      { type: 'tool_call', callId: 'l', tool: 'design.look', source: 'command', input: { design: 'obj_1' } },
      { type: 'tool_result', callId: 'l', ok: true, summary: 'Looked' } as PilotEvent,
      ...check('b', 'plan_a', { design: 'obj_1', pass: false, items: items(false) }),
      ...check('c', 'plan_c', undefined, false),
    ] as PilotEvent[]
    expect(checkCalls(events)).toEqual([
      { planId: 'plan_b', design: 'obj_1', result: 'ok', pass: true, failed: [] },
      { planId: 'plan_a', design: 'obj_1', result: 'ok', pass: false, failed: ['overall size'] },
      { planId: 'plan_c', result: 'refused', why: 'planId: there is no plan plan_c' },
    ])
    expect(checkCalls([])).toEqual([])
  })

  it('puts the design.check calls of a driven run on its results row, with each plan id', async () => {
    const r = await driveCase(asCase('check-calls'), { steps: [{ calls: [{ name: 'design.check', args: { planId: 'plan_one' } }, { name: 'design.check', args: { planId: 'plan_two' } }] }, { text: 'Checked.' }], timeoutMs: 20_000 })
    expect(r.checks.map((x) => [x.planId, x.result])).toEqual([
      ['plan_one', 'refused'],
      ['plan_two', 'refused'],
    ])
  }, 30_000)

  it('charges a renamed plan of a part already built, and frees a second part whose sheet has the same title', () => {
    const planter = BUILD_CASES.find((c) => c.id === 'planter-saucer')!
    const message: UserTurn = { kind: 'message', text: planter.prompt }
    // the planter planned, approved and built, then planned again under another name and built in the same design
    const renamed: UserTurn[] = [message, { kind: 'sheet', title: 'Planter' }, { kind: 'go', part: 'Build planter from this plan?', plan: 'p1', design: 'd1' }, { kind: 'sheet', title: 'Planter sizes' }, { kind: 'go', part: 'Build round planter from this plan?', plan: 'p2', design: 'd1' }]
    expect(extraTurns(renamed, 2).map((t) => t.kind)).toEqual(['sheet', 'go'])
    // two parts, each sized on a sheet titled the same and built in a design of its own
    const shared: UserTurn[] = [message, { kind: 'sheet', title: 'Sizes' }, { kind: 'go', part: 'Build planter from this plan?', plan: 'p1', design: 'd1' }, { kind: 'sheet', title: 'Sizes' }, { kind: 'go', part: 'Build saucer from this plan?', plan: 'p2', design: 'd2' }]
    expect(extraTurns(shared, 2)).toEqual([])
    // both sheets asked together before the one plan: the second part's sheet stays free though its part was never planned
    const together: UserTurn[] = [message, { kind: 'sheet', title: 'Round planter' }, { kind: 'sheet', title: 'Saucer' }, { kind: 'go', part: 'Build Round planter from this plan?', plan: 'p1', design: 'd1' }]
    expect(extraTurns(together, 2)).toEqual([])
    // a Go whose plan built nothing stands for its plan alone
    expect(extraTurns([message, { kind: 'go', part: 'Build planter from this plan?', plan: 'p1' }, { kind: 'go', part: 'Build planter from this plan?', plan: 'p2', design: 'd1' }], 2)).toEqual([])
  })

  it('puts each check in the summary, so a part that fails one check shows which', () => {
    const wide = summarize(scored('hinged-box', [box(0, 0, 0, 80, 50, 35), box(0, 60, 0, 130, 110, 4)]))
    expect(wide.geometry).toBe(false)
    expect(wide.checks).toMatchObject({ watertight: true, bodies: true, minWall: true, bedFit: true, sizes: false })
    expect(Object.keys(wide.checks).sort()).toEqual(['bedFit', 'bodies', 'hinge', 'lid', 'minWall', 'ops', 'sizes', 'watertight'])
    // a case with a hook adds the hook; a run that built nothing has no part checks
    expect(summarize(scored('cable-hook', [box(0, 0, 0, 40, 40, 5)])).checks.hook).toBe(false)
    const none = summarize(scored('hinged-box', []))
    expect(none.checks).toEqual({ ops: false })
  })

  it('rewrites only the score of a recording, and refuses when the old fields no longer match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'))
    try {
      const old = { pass: false, geometry: false, built: true, refused: false, extra: 0 }
      const rec = { model: 'm', provider: 'p', capturedAt: 't', steps: [{ text: 'hi' }, { calls: [{ name: 'x', args: { a: 1 } }] }], score: old }
      writeFileSync(join(dir, 'k.json'), `${JSON.stringify(rec, null, 1)}\n`)
      // a recording from before verdicts gains one
      const next = { ...old, verdict: 'fail' as const, checks: { ops: true, bodies: false } }
      refreshScore('k', next, dir)
      const after = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8')) as typeof rec
      expect(after.score).toEqual(next)
      expect({ ...after, score: old }).toEqual(rec)
      expect(() => refreshScore('k', { ...next, geometry: true }, dir)).toThrow(/geometry/)
      expect(JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8')).score).toEqual(next)
      expect(() => refreshScore('missing', next, dir)).toThrow(/no recording/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rescores a recording after a scorer change only with a reason and a clean replay, and lists what moved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'))
    try {
      const old = { pass: true, verdict: 'disagree' as const, geometry: true, built: true, refused: false, extra: 0, checks: { ops: true, minWall: true, sizes: true } }
      const rec = { model: 'm', provider: 'p', capturedAt: 't', steps: [{ text: 'hi' }, { calls: [{ name: 'x', args: { a: 1 } }] }], score: old }
      writeFileSync(join(dir, 'k.json'), `${JSON.stringify(rec, null, 1)}\n`)
      const next = { ...old, pass: false, verdict: 'fail' as const, geometry: false, checks: { ops: true, minWall: false, sizes: true } }
      // the fill-only refresh keeps its guard
      expect(() => refreshScore('k', next, dir)).toThrow(/pass false, recorded true/)
      // no reason, or a blank one, and a replay that diverged are refused, and the file is left as it was
      expect(() => rescore('k', next, {}, dir)).toThrow(/SX_MIMIR_EVAL_RESCORE_REASON/)
      expect(() => rescore('k', next, { reason: '  ' }, dir)).toThrow(/SX_MIMIR_EVAL_RESCORE_REASON/)
      expect(() => rescore('k', next, { reason: 'scorer change', replayError: 'replay diverged at request 5 (geom.extrude)' }, dir)).toThrow(/did not run clean: replay diverged at request 5/)
      expect(JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'))).toEqual(rec)
      const moves = rescore('k', next, { reason: 'the scorer reads walls as design.check does' }, dir)
      expect(moves).toEqual([
        { key: 'pass', from: true, to: false },
        { key: 'verdict', from: 'disagree', to: 'fail' },
        { key: 'geometry', from: true, to: false },
        { key: 'checks.minWall', from: true, to: false },
      ])
      expect(rescoreLine('k', moves, 'the scorer reads walls as design.check does')).toBe('RESCORE k (the scorer reads walls as design.check does): pass true -> false; verdict "disagree" -> "fail"; geometry true -> false; checks.minWall true -> false')
      // only the score changed, and the reason is not in the recording
      const after = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8')) as typeof rec
      expect(after).toEqual({ ...rec, score: next })
      expect(JSON.stringify(after)).not.toContain('design.check does')
      // a second rescore finds nothing to move
      expect(rescore('k', next, { reason: 'again' }, dir)).toEqual([])
      expect(rescoreLine('k', [], 'again')).toBe('RESCORE k (again): no change')
      expect(() => rescore('missing', next, { reason: 'x' }, dir)).toThrow(/no recording/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists a check a score gains or loses as a move from or to none', () => {
    const base = { pass: true, verdict: 'pass' as const, geometry: true, built: true, refused: false, extra: 0 }
    expect(scoreMoves({ ...base, checks: { ops: true, hook: true } }, { ...base, checks: { ops: true, lid: false } })).toEqual([
      { key: 'checks.lid', from: undefined, to: false },
      { key: 'checks.hook', from: true, to: undefined },
    ])
    expect(rescoreLine('k', [{ key: 'checks.lid', from: undefined, to: false }], 'r')).toBe('RESCORE k (r): checks.lid none -> false')
  })

  // a box from (x0, y0, z0) to (x1, y1, z1), closed and facing out
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): MeshPart => {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].flat()
    const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
    return { name: 'box', slot: 1, positions: new Float32Array(v), indices: new Uint32Array(f) }
  }
  const scored = (id: string, parts: MeshPart[]) =>
    scoreCase(BUILD_CASES.find((c) => c.id === id)!, { events: [], turns: [{ kind: 'message', text: '' }], parts, firstReply: '', firstBuilt: true, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 })

  it('sizes each body or assembly on its own, so a lid laid flat beside its box is not one wide part', () => {
    // the hinged box: an 80 by 50 by 35 mm box and its lid laid flat 10 mm in front of it, as parts print apart
    const apart = scored('hinged-box', [box(0, 0, 0, 80, 50, 35), box(0, 60, 0, 80, 110, 4)])
    expect(apart.sizes, JSON.stringify(apart.sizes)).toMatchObject({ pass: true })
  })

  // the Pi case held to a height only the box and its lid together reach (28 to 32 mm), or only together pass (16 to 32 mm)
  const tall = (minMm: number, maxMm: number, parts: MeshPart[]) => {
    const c = BUILD_CASES.find((x) => x.id === 'pi5-case')!
    return scoreCase({ ...c, sizes: [{ axis: 'z', minMm, maxMm }] }, { events: [], turns: [{ kind: 'message', text: '' }], parts, firstReply: '', firstBuilt: true, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 })
  }

  it('sizes a lid sitting on its box as one assembly: the box 26 mm high and the lid on top read 30', () => {
    const stacked = tall(28, 32, [box(0, 0, 0, 94, 65, 26), box(0, 0, 26, 94, 65, 30)])
    expect(stacked.sizes, JSON.stringify(stacked.sizes)).toMatchObject({ pass: true })
    expect(stacked.sizes?.detail).toBe('94 by 65 by 30 mm')
    expect(assemblySizes([box(0, 0, 0, 94, 65, 26), box(0, 0, 26, 94, 65, 30)])).toEqual([[94, 65, 30]])
  })

  it('fails a box and lid that are each under the size but over it together', () => {
    const over = tall(16, 32, [box(0, 0, 0, 94, 65, 20), box(0, 0, 20, 94, 65, 34)])
    expect(over.sizes, JSON.stringify(over.sizes)).toMatchObject({ pass: false })
    expect(over.sizes?.detail).toMatch(/z 34 \(want 16 to 32\)/)
  })

  it('groups bodies 0.09 mm apart and keeps bodies 0.11 mm apart separate', () => {
    expect(assemblySizes([box(0, 0, 0, 94, 65, 26), box(0, 0, 26.09, 94, 65, 30)])).toEqual([[94, 65, 30]])
    expect(assemblySizes([box(0, 0, 0, 94, 65, 26), box(0, 0, 26.11, 94, 65, 30)])).toEqual([
      [94, 65, 26],
      [94, 65, 3.9],
    ])
  })

  // a round body `d` mm across standing `h` mm tall on (cx, cy), as a closed 64-sided prism facing out
  const disc = (cx: number, cy: number, d: number, h: number): MeshPart => {
    const n = 64
    const ring = (z: number) => Array.from({ length: n }, (_, i) => [cx + (d / 2) * Math.cos((2 * Math.PI * i) / n), cy + (d / 2) * Math.sin((2 * Math.PI * i) / n), z])
    const v = [[cx, cy, 0], [cx, cy, h], ...ring(0), ...ring(h)].flat()
    const b = (i: number) => 2 + (i % n)
    const t = (i: number) => 2 + n + (i % n)
    const f = Array.from({ length: n }, (_, i) => [0, b(i + 1), b(i), 1, t(i), t(i + 1), b(i), b(i + 1), t(i + 1), b(i), t(i + 1), t(i)]).flat()
    return { name: 'disc', slot: 1, positions: new Float32Array(v), indices: new Uint32Array(f) }
  }

  it('sizes a round planter and its saucer laid out corner to corner as two parts, though their boxes overlap', () => {
    // where the recorded planter-saucer run left them: the saucer 140 mm across at (95.43, 76), the planter 120 mm
    // across at (170.57, 190), 6.5 mm apart at their nearest, while their square boxes overlap by 55 by 16 mm
    const parts = [disc(95.43, 76, 140, 15), disc(170.57, 190, 120, 100)]
    expect(assemblySizes(parts)).toEqual([
      [140, 140, 15],
      [120, 120, 100],
    ])
    const apart = scored('planter-saucer', parts)
    expect(apart.sizes, JSON.stringify(apart.sizes)).toMatchObject({ pass: true })
    // standing in its saucer, the planter is one assembly with it
    expect(assemblySizes([disc(0, 0, 140, 15), disc(0, 0, 120, 100)])).toEqual([[140, 140, 100]])
    // and a planter whose side meets the saucer's rim is too
    expect(assemblySizes([disc(0, 0, 140, 15), disc(130, 0, 120, 100)])).toEqual([[260, 140, 100]])
  })

  it('still fails a part when one body is past the size, or none reaches it', () => {
    const wide = scored('hinged-box', [box(0, 0, 0, 80, 50, 35), box(0, 60, 0, 130, 110, 4)])
    expect(wide.sizes, JSON.stringify(wide.sizes)).toMatchObject({ pass: false })
    expect(wide.sizes?.detail).toMatch(/xy 130 \(want 75 to 100\)/)
    const small = scored('hinged-box', [box(0, 0, 0, 60, 40, 35), box(0, 50, 0, 60, 90, 4)])
    expect(small.sizes, JSON.stringify(small.sizes)).toMatchObject({ pass: false })
  })

  it('reads a cable hook as holding when its hook hangs a leg past the bend, and not when it stops at the bend', () => {
    // a 10 mm square rod 60 mm up from a 40 by 40 by 5 mm plate, a bar over the top, and a leg down from its end
    const plate = box(0, 0, 0, 40, 40, 5)
    const rod = box(15, 15, 5, 25, 25, 65)
    const bar = box(15, 15, 55, 55, 25, 65)
    const leg = box(45, 15, 40, 55, 25, 65)
    const c = BUILD_CASES.find((x) => x.id === 'cable-hook')!
    const held = hookCheck(c.hook!, [plate, rod, bar, leg])
    expect(held, held.detail).toMatchObject({ pass: true })
    expect(held.detail).toMatch(/leg hangs 25 mm below the top of the hook/)
    const stub = hookCheck(c.hook!, [plate, rod, bar])
    expect(stub, stub.detail).toMatchObject({ pass: false })
  })

  it('holds a cable hook to the height of its bend: a hook that turns over at the top of its rise is too short', () => {
    const c = BUILD_CASES.find((x) => x.id === 'cable-hook')!
    const plate = box(0, 0, 0, 40, 40, 5)
    const rod = box(15, 15, 5, 25, 25, 65)
    // the bend rises 20 mm over the rod before it comes down: 90 mm tall
    const up = scored('cable-hook', [plate, rod, box(15, 15, 65, 25, 25, 90), box(15, 15, 80, 65, 25, 90), box(55, 15, 50, 65, 25, 90)])
    expect(up.sizes, up.sizes?.detail).toMatchObject({ pass: true })
    // turned over at 65 mm, it stands 70 mm (a run kept 65 by 40 by 70)
    const flat = scored('cable-hook', [plate, rod, box(15, 15, 60, 65, 25, 70), box(55, 15, 35, 65, 25, 70)])
    expect(flat.sizes?.detail).toMatch(/z 70 \(want 80 to 100\)/)
    expect(c.sizes.find((x) => x.axis === 'z')).toEqual({ axis: 'z', minMm: 80, maxMm: 100 })
  })

  it('holds a hinged box to its height closed: a lid stacked on top past the knuckles is too tall', () => {
    // the 80 by 50 by 35 box, its lid 0.4 mm over its rim
    const closed = scored('hinged-box', [box(0, 0, 0, 80, 50, 35), box(0, 0, 35.4, 80, 50, 37.4)])
    expect(closed.sizes, closed.sizes?.detail).toMatchObject({ pass: true })
    // a lid touching the top of the 35 mm box and standing 12 mm (a run kept 80 by 50 by 47)
    const stacked = scored('hinged-box', [box(0, 0, 0, 80, 50, 35), box(0, 0, 35, 80, 50, 47)])
    expect(stacked.sizes?.detail).toMatch(/z 47 \(want 33 to 45\)/)
  })

  // boxes as one part, so those that meet at a corner are one body, as a knuckle joined onto its box is
  const joined = (...boxes: MeshPart[]): MeshPart => {
    const positions: number[] = []
    const indices: number[] = []
    for (const b of boxes) {
      const at = positions.length / 3
      positions.push(...b.positions)
      indices.push(...Array.from(b.indices, (i) => i + at))
    }
    return { name: 'joined', slot: 1, positions: new Float32Array(positions), indices: new Uint32Array(indices) }
  }
  // a square knuckle from x0 to x1 around a pin line along x at y 53, z 38: 3 mm wide inside, 6 mm outside, its lower
  // front corner at y 50, z 35 (the box's back top edge), and with `lip`, its front wall standing on z0 instead
  const knuckle = (x0: number, x1: number, z0 = 35) => [
    box(x0, 50, z0, x1, 56, 36.5),
    box(x0, 50, 39.5, x1, 56, 41),
    box(x0, 50, 36.5, x1, 51.5, 39.5),
    box(x0, 54.5, 36.5, x1, 56, 39.5),
  ]

  it('reads a hinge as working only when one pin runs through a knuckle of the box and one of the lid', () => {
    // the 80 by 50 by 35 box with knuckles at both ends of its back edge, and the lid with its knuckle between them
    const base = joined(box(0, 0, 0, 80, 50, 35), ...knuckle(0, 20), ...knuckle(60, 80))
    const lid = joined(box(20.4, 0, 35.4, 59.6, 50, 36.5), ...knuckle(20.4, 59.6, 35.4))
    const pin = box(0, 52.2, 37.2, 80, 53.8, 38.8)
    expect(hingeCheck([base, lid, pin])).toEqual({ pass: true, detail: 'a pin along x: the box wraps it over 40 mm and the lid over 39 mm, held by a separate pin' })
    // the same knuckles with no pin: the lid's knuckle only lines up with the box's (a lid check alone passes this)
    expect(hingeCheck([base, lid])).toEqual({ pass: false, detail: 'no pin and no knuckle bore to read a hinge from' })
    // a pin through the box's knuckles that stops short of the lid's
    expect(hingeCheck([base, lid, box(0, 52.2, 37.2, 19.6, 53.8, 38.8)])).toEqual({ pass: false, detail: 'a pin along x: the box wraps it over 40 mm and the lid over 39 mm, a pin through the box only' })
    // a lid laid apart has no hinge
    expect(hingeCheck([box(0, 0, 0, 80, 50, 35), box(0, 60, 0, 80, 110, 4)])).toEqual({ pass: false, detail: 'no pin and no knuckle bore to read a hinge from' })
    // and the hinge is part of the geometry
    const s = scored('hinged-box', [base, lid, pin])
    expect(s.hinge?.pass).toBe(true)
    expect(scored('hinged-box', [base, lid]).geometry).toBe(false)
  })

  // a round tube standing on z0: outer radius ro and a bore of radius ri through it, both drawn with n sides
  const tube = (cx: number, cy: number, z0: number, z1: number, ro: number, ri: number, n = 32): MeshPart => {
    const v: number[] = []
    for (const [r, z] of [[ro, z0], [ro, z1], [ri, z0], [ri, z1]] as const)
      for (let i = 0; i < n; i++) v.push(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n), z)
    const [ob, ot, ib, it] = [0, n, 2 * n, 3 * n]
    const f: number[] = []
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      f.push(ob + i, ob + j, ot + j, ob + i, ot + j, ot + i)
      f.push(ib + i, it + j, ib + j, ib + i, it + i, it + j)
      f.push(ob + i, ib + j, ob + j, ob + i, ib + i, ib + j)
      f.push(ot + i, ot + j, it + j, ot + i, it + j, it + i)
    }
    return { name: 'tube', slot: 1, positions: new Float32Array(v), indices: new Uint32Array(f) }
  }
  const planned = (plan: Record<string, unknown>): PilotEvent[] => [
    { type: 'tool_call', callId: 'p', tool: 'design.plan', source: 'command', input: { part: 'Hinged box', units: 'mm', features: [], ...plan } } as PilotEvent,
    { type: 'tool_result', callId: 'p', ok: true, summary: 'Planned' } as PilotEvent,
  ]
  const scoredAs = (events: PilotEvent[], parts: MeshPart[]) =>
    scoreCase(BUILD_CASES.find((c) => c.id === 'hinged-box')!, { events, turns: [{ kind: 'message', text: '' }], parts, firstReply: '', firstBuilt: true, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 })

  it('reads how the plan says the lid prints: apart for printInPlace false or an assumption, else on its hinge', () => {
    expect(lidStated([])).toBe('assembled')
    expect(lidStated(planned({ printInPlace: ['Base', 'Lid'] }))).toBe('assembled')
    expect(lidStated(planned({ printInPlace: false }))).toBe('apart')
    expect(lidStated(planned({ assumptions: ['The lid prints beside the box and goes on after'] }))).toBe('apart')
    // a refused plan says nothing
    expect(lidStated([planned({ printInPlace: false })[0]!, { type: 'tool_result', callId: 'p', ok: false, summary: 'refused' } as PilotEvent])).toBe('assembled')
  })

  it('holds a lid planned apart to printing apart, on the bed, with a pin that fits a bore of each part', () => {
    // a 80 mm round box and its lid 20 mm apart, each with a 7 mm bore, and a 6 mm pin lying beside them
    const base = tube(0, 0, 0, 35, 40, 3.5)
    const lid = tube(100, 0, 0, 20, 40, 3.5)
    const pin = box(-30, 60, 0, 30, 66, 6)
    const apart = planned({ printInPlace: false })
    const s = scoredAs(apart, [base, lid, pin])
    expect(s.lid, JSON.stringify(s.lid)).toMatchObject({ pass: true })
    expect(s.hinge).toEqual({ pass: true, detail: 'a 6 mm pin slides into a bore of the box and a bore of the lid' })
    // the 10 mm apart part with no pin: apart as planned, but nothing joins it to the box
    const bare = scoredAs(apart, [box(0, 0, 0, 80, 50, 35), box(0, 60, 0, 80, 110, 4)])
    expect(bare.lid?.pass).toBe(true)
    expect(bare.hinge).toEqual({ pass: false, detail: 'the lid is planned apart but no separate pin was built, so nothing joins it to the box' })
    expect(bare.geometry).toBe(false)
    // and planned on its hinge, the same part fails the lid
    expect(scoredAs(planned({ printInPlace: ['Base', 'Lid'] }), [box(0, 0, 0, 80, 50, 35), box(0, 60, 0, 80, 110, 4)]).lid?.pass).toBe(false)
    // a lid 1 mm off the box, or one lifted off the bed, does not print apart
    expect(scoredAs(apart, [base, tube(81, 0, 0, 20, 40, 3.5), pin]).lid?.detail).toMatch(/comes within 1 mm of the box/)
    expect(scoredAs(apart, [base, tube(100, 0, 3, 23, 40, 3.5), pin]).lid?.detail).toMatch(/do not rest on the bed/)
    // a pin too tight for the bores
    expect(scoredAs(apart, [tube(0, 0, 0, 35, 40, 3.05), tube(100, 0, 0, 20, 40, 3.05), pin]).hinge?.pass).toBe(false)
  })

  // a 10 mm wedge prism, 20 mm long: its bottom face meets a side at 84 degrees along x = 0, with thin facets next to
  // that edge, the way a tube cut at a slant meets its bore
  const wedge = (): MeshPart => {
    const a = (84 * Math.PI) / 180
    const xs = [0, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 10]
    const q: [number, number] = [10 * Math.cos(a), 10 * Math.sin(a)]
    const v: number[] = []
    for (const y of [0, 20]) {
      for (const x of xs) v.push(x, y, 0)
      v.push(q[0], y, q[1])
    }
    const n = xs.length
    const top = n
    const f: number[] = []
    for (let i = 0; i + 1 < n; i++) f.push(i, i + 1, n + 1 + i + 1, i, n + 1 + i + 1, n + 1 + i)
    f.push(0, top, n + 1 + top, 0, n + 1 + top, n + 1, n - 1, n + 1 + n - 1, n + 1 + top, n - 1, n + 1 + top, top)
    for (let i = 0; i + 1 < n; i++) f.push(top, i + 1, i, n + 1 + top, n + 1 + i, n + 1 + i + 1)
    // each facet faces away from the inside
    const c = [(10 + q[0]) / 3, 10, q[1] / 3]
    for (let t = 0; t < f.length; t += 3) {
      const [p0, p1, p2] = [f[t]!, f[t + 1]!, f[t + 2]!].map((i) => [v[i * 3]!, v[i * 3 + 1]!, v[i * 3 + 2]!]) as [number[], number[], number[]]
      const e1 = p1.map((x, k) => x - p0[k]!)
      const e2 = p2.map((x, k) => x - p0[k]!)
      const nn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
      if (nn.reduce((s2, x, k) => s2 + x * (p0[k]! - c[k]!), 0) < 0) [f[t + 1], f[t + 2]] = [f[t + 2]!, f[t + 1]!]
    }
    return { name: 'wedge', slot: 1, positions: new Float32Array(v), indices: new Uint32Array(f) }
  }

  it('reads no wall at an edge where two faces meet near a right angle, as a tube cut at a slant has', () => {
    // design.check's read counts a far facet only where it faces back against the start, so a facet next to the edge measures no wall there
    expect(engineWall([wedge()]).mm).toBeGreaterThan(3)
    // and so does the scorer: the wedge is whole
    const w = scored('cable-clip', [wedge()]).minWall
    expect(w?.pass, w?.detail).toBe(true)
    expect(Number.parseFloat(w!.detail)).toBeGreaterThan(3)
  })

  it('reads the thinnest wall from every facet, so a small thin spot no area sample lands on still fails', () => {
    // a 40 by 40 by 10 mm block and, apart from it, a 1 mm square tab 0.1 mm thick: too little area for a sample
    const s = scored('cable-clip', [box(0, 0, 0, 40, 40, 10), box(60, 0, 0, 61, 1, 0.1)])
    expect(s.minWall).toEqual({ pass: false, detail: '0.1 mm (want 0.8 mm or more)' })
    expect(scored('cable-clip', [box(0, 0, 0, 40, 40, 10)]).minWall).toEqual({ pass: true, detail: '10 mm (want 0.8 mm or more)' })
  })

  it('reads a hinged lid as joined only when it sits on its box at a gap that prints apart', () => {
    const lid = (parts: MeshPart[]) => scored('hinged-box', parts).lid!
    const base = box(0, 0, 0, 80, 50, 35)
    // 0.4 mm over the rim: the fit rule's gap for one face printed over another with a 0.4 mm nozzle
    expect(lid([base, box(0, 0, 35.4, 80, 50, 37.4)])).toEqual({ pass: true, detail: 'lid 0.4 mm over the box (want 0.4 mm or more)' })
    // 0.39 mm over a level rim is under it: only a round face drawn as facets gets the fit check's 0.02 mm
    expect(lid([base, box(0, 0, 35.39, 80, 50, 37.39)]).pass).toBe(false)
    // 0.2 mm over it fuses
    expect(lid([base, box(0, 0, 35.2, 80, 50, 37.2)])).toEqual({ pass: false, detail: 'lid 0.2 mm over the box (want 0.4 mm or more)' })
    // a lid flat on the rim prints as one piece with it
    expect(lid([base, box(0, 0, 35, 80, 50, 37)])).toEqual({ pass: false, detail: 'the lid touches the box, so they print as one piece' })
    // a lid printed open, 0.3 mm beside the box's back, passes side by side, where the rule wants 0.3 mm
    expect(lid([base, box(0, 50.3, 0, 80, 100, 10)])).toEqual({ pass: true, detail: 'lid 0.3 mm beside the box (want 0.3 mm or more)' })
    // laid flat 10 mm in front of it, nothing joins the lid to the box (a run kept Base and Lid so, with no pin)
    expect(lid([base, box(0, 60, 0, 80, 110, 4)])).toEqual({ pass: false, detail: 'the lid lies apart from the box (nothing within 2 mm), so no hinge joins them' })
    // a box alone, or with only a pin beside it, has no lid of its own
    expect(lid([base])).toEqual({ pass: false, detail: 'one body: the lid is not a piece of its own, so it cannot open' })
    expect(lid([base, box(0, 50.5, 33, 76, 52.5, 35)])).toEqual({ pass: false, detail: 'no lid: no other body is near the size of the box, so the lid is part of the box or missing' })
    // the lid's check is part of the geometry
    expect(scored('hinged-box', [base, box(0, 60, 0, 80, 110, 4)]).geometry).toBe(false)
  })

  // a round column from z0 to z1 around (cx, cy), r0 across at the bottom and r1 at the top, with a bore `wall` mm in
  // from the outside when wall is given: its outer and inner sides and its ends, as a revolve or a loft makes them
  const column = (cx: number, cy: number, z0: number, z1: number, r0: number, r1: number, wall?: number): MeshPart => {
    const n = 48
    const pos: number[] = []
    const idx: number[] = []
    const ring = (z: number, r: number) => {
      const at = pos.length / 3
      for (let k = 0; k < n; k++) pos.push(cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n), z)
      return at
    }
    const side = (a: number, b: number) => {
      for (let k = 0; k < n; k++) idx.push(a + k, a + ((k + 1) % n), b + k, a + ((k + 1) % n), b + ((k + 1) % n), b + k)
    }
    const ob = ring(z0, r0)
    const ot = ring(z1, r1)
    side(ob, ot)
    if (wall) {
      const ib = ring(z0, r0 - wall)
      const it2 = ring(z1, r1 - wall)
      side(it2, ib)
      side(ib, ob)
      side(ot, it2)
    } else {
      const c0 = pos.length / 3
      pos.push(cx, cy, z0, cx, cy, z1)
      for (let k = 0; k < n; k++) idx.push(c0, ob + ((k + 1) % n), ob + k, c0 + 1, ot + k, ot + ((k + 1) % n))
    }
    return { name: 'column', slot: 1, positions: new Float32Array(pos), indices: new Uint32Array(idx) }
  }

  it('reads a stand\'s stem from the part itself, so a revolved stem is judged as a lofted one', () => {
    const c = BUILD_CASES.find((x) => x.id === 'headphone-stand')!
    // a base 110 mm across and 12 mm thick, a hollow stem tapering from 30 to 22 mm across up to 162 mm, revolved
    const base = column(128, 128, 0, 12, 55, 55)
    const stem = column(128, 128, 12, 162, 15, 11, 2.5)
    // an arm out of the stem's side 10 mm below its top, 60 mm long, and a lip 15 mm up at its end
    const arm = box(137, 122, 146, 196, 134, 158)
    const lip = box(186, 122, 158, 196, 134, 173)
    const held = hookCheck(c.hook!, [base, stem, arm, lip])
    expect(held, held.detail).toMatchObject({ pass: true })
    // read on rings inside its ends: 29 mm across 10 mm up the stem
    expect(held.detail).toMatch(/stem tapers from 29 to 22 mm across, hollow/)
    expect(held.detail).toMatch(/joined to the stem at its side below its top/)
    // the same arm with no lip: nothing keeps the headband on
    const bare = hookCheck(c.hook!, [base, stem, arm])
    expect(bare, bare.detail).toMatchObject({ pass: false })
    expect(bare.detail).toMatch(/rises only/)
  })

  describe('a stand\'s hook, joined to its stem at the side or the top', () => {
    const c = BUILD_CASES.find((x) => x.id === 'headphone-stand')!
    // the same stand: a base 110 mm across, a hollow stem tapering from 30 to 22 mm across up to 162 mm
    const stand = () => [column(128, 128, 0, 12, 55, 55), column(128, 128, 12, 162, 15, 11, 2.5)]

    it('passes a hook off the stem\'s top, as the prompt asks for a hook at the top', () => {
      // a 60 mm arm laid on the stem's top, and a lip 15 mm up at its end
      const r = hookCheck(c.hook!, [...stand(), box(120, 122, 162, 196, 134, 170), box(186, 122, 170, 196, 134, 185)])
      expect(r, r.detail).toMatchObject({ pass: true })
      expect(r.detail).toMatch(/joined to the stem at its top/)
    })

    it('passes a hook off the stem\'s side below its top', () => {
      // an arm out of the stem's side 10 mm below its top, its end inside the wall, and the same lip
      const r = hookCheck(c.hook!, [...stand(), box(137, 122, 146, 196, 134, 158), box(186, 122, 158, 196, 134, 173)])
      expect(r, r.detail).toMatchObject({ pass: true })
      expect(r.detail).toMatch(/joined to the stem at its side below its top/)
    })

    it('fails a hook that floats clear of the stem', () => {
      // the same arm and lip 2 mm clear of the stem's side: nothing holds the hook up
      const r = hookCheck(c.hook!, [...stand(), box(142, 122, 146, 196, 134, 158), box(186, 122, 158, 196, 134, 173)])
      expect(r, r.detail).toMatchObject({ pass: false })
      expect(r.detail).toMatch(/not joined to the stem/)
    })

    it('fails a hook that meets the stem only at a point', () => {
      // an arm whose bottom edge only touches the rim of the stem's top, at one corner of it
      const r = hookCheck(c.hook!, [...stand(), box(139, 122, 162, 196, 134, 170), box(186, 122, 170, 196, 134, 185)])
      expect(r, r.detail).toMatchObject({ pass: false })
      expect(r.detail).toMatch(/not joined to the stem/)
    })

    it('fails a hook whose tip does not rise', () => {
      // the arm on the stem's top with no lip: joined, but nothing keeps the headband on
      const r = hookCheck(c.hook!, [...stand(), box(120, 122, 162, 196, 134, 170)])
      expect(r, r.detail).toMatchObject({ pass: false })
      expect(r.detail).toMatch(/rises only/)
    })
  })

  // a recording as a live run made it: a lookup, then a reply, each reply with the results it read
  const lookup = [{ calls: [{ name: 'parts.lookup', args: { name: 'M3' } }] }, { text: 'Done.' }]

  it('fails a replay whose tool result differs from the recorded one, naming the request and the tool', async () => {
    const c = asCase('diverge-lookup')
    const live = await driveCase(c, { steps: lookup, timeoutMs: 20_000 })
    expect(live.steps[1]?.seen).toHaveLength(1)
    // an ok that was recorded as an error says so
    const flipped = structuredClone(live.steps)
    flipped[1]!.seen = [JSON.stringify({ ok: false, error: 'The shape no longer reaches the part.' })]
    const f = await driveCase(c, { steps: flipped, timeoutMs: 20_000 })
    expect(f.error).toMatch(/^replay diverged at request 2 \(parts\.lookup\): recorded failed "The shape no longer reaches the part\.", got ok "M3 screw/)
    // a tool that changes the design says something else: the recording saw a design start where this one refuses
    const start = await driveCase(asCase('diverge-new'), { steps: [{ calls: [{ name: 'design.new', args: { name: 'Diverge new probe' } }] }, { text: 'Done.' }], timeoutMs: 20_000 })
    const moved = structuredClone(start.steps)
    moved[1]!.seen = moved[1]!.seen!.map((t) => t.replace('Started', 'Started again'))
    const m = await driveCase(asCase('diverge-new'), { steps: moved, timeoutMs: 20_000 })
    expect(m.error).toMatch(/^replay diverged at request 2 \(design\.new\): recorded ok "Started again Diverge new probe \(<id>\)", got ok "Started Diverge new probe \(<id>\)"/)
  }, 30_000)

  it('replays a recording whose tool results match, ignoring the ids a run makes, and one without results', async () => {
    const c = asCase('diverge-match')
    const live = await driveCase(c, { steps: lookup, timeoutMs: 20_000 })
    expect((await driveCase(c, { steps: live.steps, timeoutMs: 20_000 })).error).toBeUndefined()
    // a new design is named by an id made from the time, so each run's differs from the recorded one
    const start = await driveCase(asCase('diverge-ids'), { steps: [{ calls: [{ name: 'design.new', args: { name: 'Diverge ids probe' } }] }, { text: 'Done.' }], timeoutMs: 20_000 })
    expect(start.steps[1]?.seen?.[0]).toMatch(/obj_[0-9a-z]+/)
    const stamped = structuredClone(start.steps)
    stamped[1]!.seen = stamped[1]!.seen!.map((t) => t.replace(/obj_[0-9a-z]+/g, 'obj_zz11aa22bb'))
    const again = await driveCase(asCase('diverge-ids'), { steps: stamped, timeoutMs: 20_000 })
    expect(again.error).toBeUndefined()
    // a recording from before results were kept is not checked
    expect((await driveCase(c, { steps: lookup, timeoutMs: 20_000 })).error).toBeUndefined()
  }, 30_000)

  it('reads what a reply says of its own check, tightly, and a failed check over a passed one', () => {
    expect(replyClaim('The design check failed twice, and I have stopped building.')).toBe('fail')
    expect(replyClaim('The clip is not finished. The design check stopped it.')).toBe('fail')
    expect(replyClaim("The hook is modeled, but it fails the plan's size check, so I've stopped.")).toBe('fail')
    expect(replyClaim("I built most of the box, but it doesn't pass the print-in-place check yet.")).toBe('fail')
    expect(replyClaim('It has not passed the check.')).toBe('fail')
    // a failed item next to passed ones is a failed check
    expect(replyClaim('The plan check failed on one item. The other five checks pass.')).toBe('fail')
    expect(replyClaim('The vase passes the plan check, but the walls come out at 1.66 mm.')).toBe('pass')
    expect(replyClaim('The planter now passes all three plan checks.')).toBe('pass')
    // a check that may come later, or none at all, says nothing
    expect(replyClaim('If the check fails, I will widen the bore.')).toBeNull()
    expect(replyClaim('Built the stand. I have not sliced it or sent it to the printer.')).toBeNull()
    expect(replyClaim('Checked the part against its plan.')).toBeNull()
  })

  it('reads the last design.check result, and prefers it to the reply', () => {
    const check = (id: string, pass?: boolean, ok = true): PilotEvent[] => [
      { type: 'tool_call', callId: id, tool: 'design.check', source: 'command', input: { planId: 'p' } },
      { type: 'tool_result', callId: id, ok, summary: 'checked', ...(pass === undefined ? {} : { output: { pass } }) } as PilotEvent,
    ]
    expect(lastCheckPass([])).toBeNull()
    expect(lastCheckPass([...check('a', false), ...check('b', true)])).toBe(true)
    expect(lastCheckPass([...check('a', true), ...check('b', false)])).toBe(false)
    // a check that did not go through, or a tool that is not the check, says nothing
    expect(lastCheckPass([...check('a', false), ...check('b', undefined, false)])).toBe(false)
    expect(lastCheckPass([{ type: 'tool_call', callId: 'x', tool: 'geom.info', source: 'command', input: {} }, { type: 'tool_result', callId: 'x', ok: true, summary: '', output: { pass: true } } as PilotEvent])).toBeNull()
    expect(runClaim({ check: true, reply: 'The design check failed.' })).toEqual({ said: 'pass', from: 'check' })
    expect(runClaim({ check: null, reply: 'The design check failed.' })).toEqual({ said: 'fail', from: 'reply' })
    expect(runClaim({ check: null, reply: 'Built it.' })).toEqual({ said: null, from: null })
    expect(checkFromCalls(['design.check ok (part failed)', 'geom.build ok', 'design.check ok (part passed)'])).toBe(true)
    expect(checkFromCalls(['design.check ok (part failed)', 'design.check FAIL no plan'])).toBe(false)
    expect(checkFromCalls(['design.check ok'])).toBeNull()
  })

  it('counts a run whose own check contradicts the scorer as disagree, never as a pass', () => {
    const said = (s: 'pass' | 'fail' | null) => ({ said: s, from: s ? ('check' as const) : null })
    expect(verdictOf({ pass: true, geometry: true }, said(null))).toBe('pass')
    expect(verdictOf({ pass: true, geometry: true }, said('pass'))).toBe('pass')
    expect(verdictOf({ pass: true, geometry: true }, said('fail'))).toBe('disagree')
    expect(verdictOf({ pass: false, geometry: false }, said('pass'))).toBe('disagree')
    expect(verdictOf({ pass: false, geometry: false }, said('fail'))).toBe('fail')
    // a part the scorer passes, failed on turns alone, agrees with a run that says its part passed
    expect(verdictOf({ pass: false, geometry: true }, said('pass'))).toBe('fail')
    const { byCase, all } = verdictCounts([
      { id: 'cable-hook', verdict: 'pass' },
      { id: 'hinged-box', verdict: 'disagree' },
      { id: 'cable-hook', verdict: 'disagree' },
      { id: 'cable-hook', verdict: 'fail' },
    ])
    expect(all).toEqual({ pass: 1, fail: 1, disagree: 2 })
    expect([...byCase]).toEqual([
      ['cable-hook', { pass: 1, fail: 1, disagree: 1 }],
      ['hinged-box', { pass: 0, fail: 0, disagree: 1 }],
    ])
  })

  // six live runs as their results lines kept them (fixtures/mimir-build-eval-runs.json): the scorer's result, the
  // calls and the first 800 characters of the reply. Their calls predate checks saying passed or failed, so the claim
  // comes from the reply.
  const runs = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'mimir-build-eval-runs.json'), 'utf8')) as { run: string; case: string; pass: boolean; geometry: boolean; calls: string[]; reply: string }[]

  it('scores the six recorded runs whose reply contradicts the scorer as disagree', () => {
    const judged = runs.map((r) => {
      const claim = runClaim({ check: checkFromCalls(r.calls), reply: r.reply })
      return { run: r.run, was: r.pass ? 'pass' : 'fail', said: claim.said, from: claim.from, verdict: verdictOf(r, claim) }
    })
    expect(judged).toEqual([
      // hinged box: the lid sits on the base with no gap and the box is 47 mm tall; the scorer passed it
      { run: 'h2', was: 'pass', said: 'fail', from: 'reply', verdict: 'disagree' },
      // hinged box: a 0.4 mm wall and 0.29 mm pin clearance after the fix round; the scorer passed it
      { run: 'eb1', was: 'pass', said: 'fail', from: 'reply', verdict: 'disagree' },
      // cable hooks whose plan size check failed; the scorer passed both
      { run: 'ac4', was: 'pass', said: 'fail', from: 'reply', verdict: 'disagree' },
      { run: 'ac5', was: 'pass', said: 'fail', from: 'reply', verdict: 'disagree' },
      // cable hooks the reply says pass: one built without a sweep, one bent only 90 degrees with a 10 mm leg
      { run: 'ec5', was: 'fail', said: 'pass', from: 'reply', verdict: 'disagree' },
      { run: 'ac3', was: 'fail', said: 'pass', from: 'reply', verdict: 'disagree' },
    ])
  })

  it('fails a vase, bottle or planter whose cavity runs out through the bottom, as design.check does', () => {
    // the parts mimir built in recorded runs (packages/mcp/test/holder-floor.test.ts says where each one came from)
    const fixtures = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../../mcp/test/fixtures/holder-floors.json.gz'))).toString('utf8')) as Record<string, { parts: { name: string; positions: number[]; indices: number[] }[] }>
    const parts = (id: string): MeshPart[] => fixtures[id]!.parts.map((p, slot) => ({ name: p.name, slot, positions: Float32Array.from(p.positions), indices: Uint32Array.from(p.indices) }))
    const floorOf = (id: string) => BUILD_CASES.find((c) => c.id === id)!.floor!
    expect(BUILD_CASES.filter((c) => c.floor).map((c) => c.id)).toEqual(['square-bottle', 'twisted-vase', 'flared-vase', 'planter-saucer'])
    const open = floorCheck(floorOf('twisted-vase'), parts('twisted-vase-open'))
    expect(open.pass).toBe(false)
    expect(open.detail).toMatch(/^open at the bottom: Vase body: the cavity runs through the bottom face at z 0, /)
    expect(floorCheck(floorOf('square-bottle'), parts('square-bottle'))).toEqual({ pass: true, detail: 'closed: solid across the bottom face at z 0' })
    // the planter's five drain holes are the 6 mm the request asks for
    expect(floorCheck(floorOf('planter-saucer'), parts('planter-saucer'))).toEqual({ pass: true, detail: 'closed: solid across the bottom face at z 0 (holes up to the planned size aside)' })
    expect(floorCheck({ mm: 3 }, parts('planter-saucer')).pass).toBe(false)
  })

  it('knows which recorded replays disagree with the scorer', () => {
    // twisted-vase's last check passed live, floor included, and the scorer fails it: it swept the twisted walls where
    // the case asks for a loft, and the Go on its amended plan is an extra turn. cable-clip left this list when the
    // scorer read its 0.41 mm floor as design.check does, and phone-stand-lip when the scorer read its 0.23 mm wedge as
    // design.check does. watering-spout and coat-hook left it when design.check read the wall at a slanted cut as a
    // whole wall (1.334 and 3.05 mm), so their replayed checks pass as the scorer does
    const disagree = BUILD_CASES.filter((c) => loadRecording(c.id)?.score.verdict === 'disagree').map((c) => c.id)
    expect(disagree).toEqual(['twisted-vase'])
  })

  it('prices a live run on Haiku or Sonnet 5.5 and refuses a model with no price', () => {
    expect(evalPrice(EVAL_MODEL)).toBe(HAIKU_5_5)
    expect(evalPrice('claude-sonnet-5-5')).toBe(SONNET_5_5)
    // $2 and $10 per million tokens at every length, as supabase/migrations/0028_mimir_step_up.sql bills it
    expect(SONNET_5_5).toEqual({ usdIn: 2, usdOut: 10, usdPerSearch: 0.01, long: { above: 1_000_000, usdIn: 2, usdOut: 10 } })
    expect(() => evalPrice('claude-opus-5-5')).toThrow(/claude-opus-5-5 needs its price added first/)
    expect(tabConfig('claude-sonnet-5-5')).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
  })

  it('runs the tab on a key for the eval model', () => {
    expect(tabConfig(EVAL_MODEL)).toMatchObject({ provider: 'anthropic', model: EVAL_MODEL })
  })
})

const line = (id: string, r: CaseRun, usd?: number, model?: string): string => {
  const s = r.score
  const checks = [s.ops, s.watertight, s.bodies, s.minWall, s.bedFit, s.sizes, s.hook, s.lid, s.hinge, s.floor].map((c, i) => (c ? `${['ops', 'closed', 'bodies', 'wall', 'bed', 'size', 'hook', 'lid', 'hinge', 'floor'][i]} ${c.pass ? 'ok' : 'FAIL'} (${c.detail})` : '')).filter(Boolean)
  const said = s.claim.said ? `  says ${s.claim.said} (${s.claim.from === 'check' ? 'last design.check' : 'reply'})` : ''
  return `${(s.verdict === 'fail' && s.refused ? 'REFUSED' : s.verdict.toUpperCase()).padEnd(8)} ${id.padEnd(16)} turns ${s.turns.pass ? 'ok' : 'FAIL'} (${s.turns.detail})  ${checks.join('  ')}${said}${model ? `  ${model}` : ''}${usd === undefined ? '' : `  $${usd.toFixed(3)}`}${r.error ? `  error: ${r.error}` : ''}`
}

/**
 * Cases whose replay rebuilds a lofted shell: about a minute each here and over three on a hosted runner, until loft
 * rebuilds get faster. They replay only with SX_SLOW_EVALS=1 (the nightly run, or a machine with a built engine).
 */
const SLOW_REPLAYS = new Set(['twisted-vase', 'flared-vase'])
const slowEvals = process.env['SX_SLOW_EVALS'] === '1'

/**
 * Cases whose recording holds an engine answer that has since been corrected, so they no longer replay. hinged-box: its
 * fit check was recorded as "Base and Lid touch, 0.0 mm", a false contact from a number read one unit in the last place
 * off; read exactly, the check answers a 0.38 mm gap, which is what the design has. Each is captured again once the
 * exact solid work has landed, and leaves this list then.
 */
const PAUSED_REPLAYS = new Set(['hinged-box'])

describe.skipIf(live || !liveEngine)('recorded build eval replies', () => {
  beforeAll(async () => setGeomProvider(await wasmGeom()))
  afterAll(() => setGeomProvider(null))
  for (const c of BUILD_CASES) {
    const rec = loadRecording(c.id)
    const slow = SLOW_REPLAYS.has(c.id)
    // a lofted vase with a shell takes about a minute to rebuild in the engine; the drive stops a replay at REPLAY_DRIVE_MS
    // (and says so in r.error), just under the 180 s the test is given
    const title = slow && !slowEvals ? `${c.id} scores as it did live (lofted, slow to rebuild: set SX_SLOW_EVALS=1)` : `${c.id} scores as it did live`
    it.skipIf(!rec || (slow && !slowEvals) || PAUSED_REPLAYS.has(c.id))(title, { timeout: 180_000 }, async () => {
      const r = await driveCase(c, { steps: rec!.steps, timeoutMs: REPLAY_DRIVE_MS })
      console.log(line(c.id, r))
      // SX_MIMIR_EVAL_RESCORE=1 (with SX_MIMIR_EVAL_RESCORE_REASON) writes this replay's score over the stored one after
      // a scorer change, and logs each field it moved; it refuses a replay that did not run clean
      if (process.env['SX_MIMIR_EVAL_RESCORE'] === '1') {
        const reason = process.env['SX_MIMIR_EVAL_RESCORE_REASON']
        // written straight to the run's output: vitest keeps a passing test's console lines to itself
        process.stdout.write(`${rescoreLine(c.id, rescore(c.id, summary(r), { reason, replayError: r.error }), reason!.trim())}\n`)
        return
      }
      expect(r.error, r.error).toBeUndefined()
      // SX_MIMIR_EVAL_UPDATE_SCORES=1 fills the score fields a recording lacks from this replay; it refuses if the fields it has differ
      if (process.env['SX_MIMIR_EVAL_UPDATE_SCORES'] === '1') refreshScore(c.id, summary(r))
      else expect(summary(r)).toEqual(rec!.score)
      if (c.id === 'planter-saucer') {
        // the five drain holes are in the planter's floor, and the saucer and planter stand 6.5 mm apart corner to
        // corner on the plate: each is sized on its own, though their square boxes overlap
        expect(r.score.bodies, JSON.stringify(r.score.bodies)).toEqual({ pass: true, detail: '2 (want 2 to 2)' })
        // in the order the run built them
        expect(r.score.sizes?.detail.replace(/ mm$/, '').split(', ').sort()).toEqual(['120 by 120 by 100', '140 by 140 by 15'])
      }
      if (c.id === 'tapered-hook') {
        // its check failed on the overall size, and it changed the approved plan with amends: the Go on that change is a
        // plan change, not another Go
        expect(r.turns.map((t) => t.kind)).toEqual(['message', 'sheet', 'go', 'amend'])
        expect(r.score.turns).toEqual({ pass: true, detail: 'one message, sheet and Go only, and one plan change' })
      }
    })
  }
  // A failed test runs again in the same process (scripts/ci/pr-test.sh, --retry=1), after an attempt that may have
  // left a finished sketch in the design timeline. The retry starts from an empty timeline, so its steps number from 1
  // as the recording's do and it replays as a first attempt does. phone-stand-lip draws three sketches of its own.
  it.skipIf(!loadRecording('phone-stand-lip'))('replays a case after an earlier attempt left a sketch in the timeline, as it did live', { timeout: 180_000 }, async () => {
    const c = BUILD_CASES.find((x) => x.id === 'phone-stand-lip')!
    const rec = loadRecording(c.id)!
    const left = finishSketch({ loops: [{ points: [[0, 0], [20, 0], [20, 10], [0, 10]] }] }).id
    expect(get().timeline.items.map((i) => i.id)).toContain(left)
    const r = await driveCase(c, { steps: rec.steps, timeoutMs: REPLAY_DRIVE_MS })
    expect(r.error, r.error).toBeUndefined()
    expect(summary(r)).toEqual(rec.score)
    expect(get().timeline.items.map((i) => i.id)).not.toContain(left)
    // the recording draws sketches of its own, so they number from the timeline's first: Sketch 1 on, and the next one
    // carries on from them (an uncleared leftover would have taken Sketch 1)
    const names = get().timeline.items.filter((i) => i.kind === 'sketch').map((i) => i.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names).toEqual(names.map((_, k) => `Sketch ${k + 1}`))
    expect(finishSketch({ loops: [{ points: [[0, 0], [20, 0], [20, 10], [0, 10]] }] }).name).toBe(`Sketch ${names.length + 1}`)
  })
})

describe.runIf(live)('live build evals', () => {
  const model = process.env['SX_MIMIR_EVAL_MODEL'] ?? EVAL_MODEL
  const cap = Number(process.env['SX_MIMIR_EVAL_CAP'] ?? '0.5')
  const ids = process.env['SX_MIMIR_EVAL_CASES']?.split(',').filter(Boolean)
  const cases = ids ? BUILD_CASES.filter((c) => ids.includes(c.id)) : BUILD_CASES
  const budget = createBudget(cap)
  const record = process.env['SX_MIMIR_EVAL_RECORD'] === '1'
  // set before any case runs; a model with no price fails the run there
  let price: ReturnType<typeof evalPrice> | undefined
  const rows: { id: string; run: CaseRun; usd: number }[] = []
  beforeAll(async () => {
    price = evalPrice(model)
    if (!liveEngine) throw new Error('a live run scores the parts, so it needs the geometry engine: build packages/geom/wasm (scripts/build.sh)')
    if (record && model !== EVAL_MODEL) throw new Error(`recordings are kept for ${EVAL_MODEL} only; run ${model} without SX_MIMIR_EVAL_RECORD=1`)
    if (!(cap > STOP_MARGIN_USD)) throw new Error(`SX_MIMIR_EVAL_CAP must be more than the ${STOP_MARGIN_USD} stop margin`)
    if (!(await createNodeTransport().available('anthropic'))) throw new Error('no key: set ANTHROPIC_API_KEY')
    setGeomProvider(await wasmGeom())
  })
  afterAll(() => {
    setGeomProvider(null)
    // a disagree is counted on its own, never as a pass
    const counts = verdictCounts(rows.map((r) => ({ id: r.id, verdict: r.run.score.verdict })))
    const tally = (n: { pass: number; fail: number; disagree: number }) => `${n.pass} pass, ${n.fail} fail, ${n.disagree} disagree`
    const perCase = [...counts.byCase].map(([id, n]) => `${id.padEnd(16)} ${tally(n)}`).join('\n')
    console.log(`\n${rows.map((r) => line(r.id, r.run, r.usd, model)).join('\n')}\n\n${perCase}\nlive ${model}: ${rows.length} of ${cases.length} run: ${tally(counts.all)}, spent $${budget.spentUsd.toFixed(3)} of $${cap.toFixed(2)}${budget.stopped ? ' (stopped at the cap)' : ''}`)
    const out = process.env['SX_MIMIR_EVAL_OUT']
    if (out) {
      const at = new Date().toISOString()
      appendFileSync(out, `${JSON.stringify({ at, model, label: process.env['SX_MIMIR_EVAL_LABEL'] ?? '', usd: Math.round(budget.spentUsd * 1000) / 1000, cap, stopped: budget.stopped, cases: rows.map((r) => ({ id: r.id, model, usd: Math.round(r.usd * 1000) / 1000, ...summary(r.run), turns: r.run.score.turns.detail, ops: r.run.score.ops.detail, sizes: r.run.score.sizes?.detail ?? null, hook: r.run.score.hook?.detail ?? null, lid: r.run.score.lid?.detail ?? null, hinge: r.run.score.hinge?.detail ?? null, claim: r.run.score.claim, calls: r.run.calls, checkCalls: r.run.checks, reply: r.run.reply, ...(r.run.error ? { error: r.run.error } : {}) })) })}\n`)
    }
  })
  for (const c of cases) {
    it(c.id, { timeout: 600_000 }, async () => {
      if (!canStart(budget)) {
        budget.stopped = true
        console.log(`SKIP     ${c.id}: the spend reached the cap less the margin`)
        return
      }
      const before = budget.spentUsd
      const base = createTransportClient(createNodeTransport(), 'anthropic', { baseUrl: tabConfig(model).baseUrl! })
      const r = await driveCase(c, { client: budgetedClient(base, model, price!, budget), model })
      const usd = budget.spentUsd - before
      rows.push({ id: c.id, run: r, usd })
      console.log(line(c.id, r, usd, model))
      // a run the budget stopped, or one that ended on an error, is not what the model would do: it is never recorded
      if (record) recordLive(c.id, r, { model, provider: 'anthropic', stopped: budget.stopped })
    })
  }
})
