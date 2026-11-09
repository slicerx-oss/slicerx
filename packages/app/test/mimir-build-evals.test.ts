// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir build evals: sixteen parts asked for in one message, most needing a loft or a sweep, four boxy controls and
// a planter with its saucer asked for as two parts, run through the tab exactly as the desktop app makes it
// (test/mimir-build-evals/drive.ts) and scored on the part and on the person's turns (score.ts). By default this checks
// the scoring, and replays offline each case that has a recording in test/mimir-build-evals/recordings (a case without
// one skips until a live run records it); a replay needs the geometry engine (packages/geom/wasm/scripts/build.sh) and
// skips without it. The lofted vases replay only with SX_SLOW_EVALS=1, since their shells are slow to rebuild.
//
// A live run asks the model and records nothing unless told to:
//   SX_MIMIR_EVAL=live [SX_MIMIR_EVAL_CASES=id,id] [SX_MIMIR_EVAL_CAP=0.50] [SX_MIMIR_EVAL_RECORD=1]
//   [SX_MIMIR_EVAL_OUT=results.jsonl] [SX_MIMIR_EVAL_LABEL=what changed] vitest run test/mimir-build-evals.test.ts
// with ANTHROPIC_API_KEY in the environment. It runs on Haiku at its published price; no new request starts once the
// spend reaches the cap less the stop margin, and no case starts past it.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MeshPart, PilotEvent } from '@slicerx/contracts'
import { createTransportClient } from '@slicerx/pilot'
import { createNodeTransport } from '@slicerx/pilot/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { budgetedClient, canStart, createBudget, HAIKU_5_5, STOP_MARGIN_USD } from '../../mcp/evals/creative/live'
import { setGeomProvider } from '../src/geom/client'
import { liveEngine, wasmGeom } from './geom-engine'
import { BUILD_CASES } from './mimir-build-evals/cases'
import { driveCase, EVAL_MODEL, tabConfig, type CaseRun } from './mimir-build-evals/drive'
import { loadRecording, recordLive, refreshScore, summarize } from './mimir-build-evals/recordings'
import { assemblySizes, classifyNoBuild, extraTurns, hookCheck, okSteps, scoreCase, type UserTurn } from './mimir-build-evals/score'

const live = process.env['SX_MIMIR_EVAL'] === 'live'

const summary = (r: CaseRun) => summarize(r.score)
/** A replay's own limit on the drive, just under the 180 s the test is given, so a stalled replay fails with its error and not as a vitest timeout. */
const REPLAY_DRIVE_MS = 170_000

describe('build eval scoring', () => {
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

  it('has the sixteen cases, the headphone stand in the words of the request', () => {
    expect(BUILD_CASES.map((c) => c.id)).toEqual(['headphone-stand', 'square-bottle', 'cable-hook', 'mug-handle', 'twisted-vase', 'pipe-elbow', 'pi5-case', 'hinged-box', 'flared-vase', 'drawer-handle', 'cable-clip', 'phone-stand-lip', 'planter-saucer', 'coat-hook', 'watering-spout', 'tapered-hook'])
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

  // an empty design stays in the design host after the drive clears the plate, so this one has a name no recording uses
  it('keys a Go on the design its plan built, read from the plan the person approved', async () => {
    const c = asCase('plan-tie')
    const plan = { part: 'cable clip', units: 'mm', features: [{ name: 'base', kind: 'extrude', sizes: { width: 20 } }, { name: 'hook', kind: 'extrude', sizes: { width: 10 } }], assumptions: [], questions: [] }
    const r = await driveCase(c, { steps: [{ calls: [{ name: 'design.plan', args: plan }] }, { calls: [{ name: 'design.new', args: { name: 'Plan tie clip' } }] }, { text: 'Started the clip.' }], timeoutMs: 20_000 })
    const go = r.turns.find((t) => t.kind === 'go')
    expect(go, JSON.stringify(r.calls)).toMatchObject({ kind: 'go', part: 'Build cable clip from this plan?', plan: expect.stringMatching(/^plan_/) })
    expect(go?.kind === 'go' && go.design).toMatch(/^obj_/)
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
    expect(Object.keys(wide.checks).sort()).toEqual(['bedFit', 'bodies', 'ops', 'sizes', 'watertight'].concat('minWall').sort())
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
      const next = { ...old, checks: { ops: true, bodies: false } }
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
    expect(held.detail).toMatch(/leaves the stem side below its top/)
    // the same arm with no lip: nothing keeps the headband on
    const bare = hookCheck(c.hook!, [base, stem, arm])
    expect(bare, bare.detail).toMatchObject({ pass: false })
    expect(bare.detail).toMatch(/rises only/)
    // an arm that sits on the stem's top, not its side
    const onTop = hookCheck(c.hook!, [base, stem, box(120, 122, 162, 196, 134, 170), box(186, 122, 170, 196, 134, 185)])
    expect(onTop, onTop.detail).toMatchObject({ pass: false })
    expect(onTop.detail).toMatch(/meets the stem only at its top/)
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

  it('runs the tab on a key for the eval model', () => {
    expect(tabConfig(EVAL_MODEL)).toMatchObject({ provider: 'anthropic', model: EVAL_MODEL })
  })
})

const line = (id: string, r: CaseRun, usd?: number): string => {
  const s = r.score
  const checks = [s.ops, s.watertight, s.bodies, s.minWall, s.bedFit, s.sizes, s.hook].map((c, i) => (c ? `${['ops', 'closed', 'bodies', 'wall', 'bed', 'size', 'hook'][i]} ${c.pass ? 'ok' : 'FAIL'} (${c.detail})` : '')).filter(Boolean)
  return `${(s.pass ? 'PASS' : s.refused ? 'REFUSED' : 'FAIL').padEnd(8)} ${id.padEnd(16)} turns ${s.turns.pass ? 'ok' : 'FAIL'} (${s.turns.detail})  ${checks.join('  ')}${usd === undefined ? '' : `  $${usd.toFixed(3)}`}${r.error ? `  error: ${r.error}` : ''}`
}

/**
 * Cases whose replay rebuilds a lofted shell: about a minute each here and over three on a hosted runner, until loft
 * rebuilds get faster. They replay only with SX_SLOW_EVALS=1 (the nightly run, or a machine with a built engine).
 */
const SLOW_REPLAYS = new Set(['twisted-vase', 'flared-vase'])
const slowEvals = process.env['SX_SLOW_EVALS'] === '1'

describe.skipIf(live || !liveEngine)('recorded build eval replies', () => {
  beforeAll(async () => setGeomProvider(await wasmGeom()))
  afterAll(() => setGeomProvider(null))
  for (const c of BUILD_CASES) {
    const rec = loadRecording(c.id)
    const slow = SLOW_REPLAYS.has(c.id)
    // a lofted vase with a shell takes about a minute to rebuild in the engine; the drive stops a replay at REPLAY_DRIVE_MS
    // (and says so in r.error), just under the 180 s the test is given
    const title = slow && !slowEvals ? `${c.id} scores as it did live (lofted, slow to rebuild: set SX_SLOW_EVALS=1)` : `${c.id} scores as it did live`
    it.skipIf(!rec || (slow && !slowEvals))(title, { timeout: 180_000 }, async () => {
      const r = await driveCase(c, { steps: rec!.steps, timeoutMs: REPLAY_DRIVE_MS })
      console.log(line(c.id, r))
      expect(r.error, r.error).toBeUndefined()
      // SX_MIMIR_EVAL_UPDATE_SCORES=1 fills the score fields a recording lacks from this replay; it refuses if the fields it has differ
      if (process.env['SX_MIMIR_EVAL_UPDATE_SCORES'] === '1') refreshScore(c.id, summary(r))
      else expect(summary(r)).toEqual(rec!.score)
      if (c.id === 'planter-saucer') {
        // the five drain holes are in the planter's floor, and the saucer and planter stand 6.5 mm apart corner to
        // corner on the plate: each is sized on its own, though their square boxes overlap
        expect(r.score.bodies, JSON.stringify(r.score.bodies)).toEqual({ pass: true, detail: '2 (want 2 to 2)' })
        expect(r.score.sizes?.detail).toBe('140 by 140 by 15, 120 by 120 by 100 mm')
      }
    })
  }
})

describe.runIf(live)('live build evals', () => {
  const model = process.env['SX_MIMIR_EVAL_MODEL'] ?? EVAL_MODEL
  const cap = Number(process.env['SX_MIMIR_EVAL_CAP'] ?? '0.5')
  const ids = process.env['SX_MIMIR_EVAL_CASES']?.split(',').filter(Boolean)
  const cases = ids ? BUILD_CASES.filter((c) => ids.includes(c.id)) : BUILD_CASES
  const budget = createBudget(cap)
  const rows: { id: string; run: CaseRun; usd: number }[] = []
  beforeAll(async () => {
    if (!liveEngine) throw new Error('a live run scores the parts, so it needs the geometry engine: build packages/geom/wasm (scripts/build.sh)')
    if (model !== EVAL_MODEL) throw new Error(`live runs price ${EVAL_MODEL} only; ${model} needs its price added first`)
    if (!(cap > STOP_MARGIN_USD)) throw new Error(`SX_MIMIR_EVAL_CAP must be more than the ${STOP_MARGIN_USD} stop margin`)
    if (!(await createNodeTransport().available('anthropic'))) throw new Error('no key: set ANTHROPIC_API_KEY')
    setGeomProvider(await wasmGeom())
  })
  afterAll(() => {
    setGeomProvider(null)
    const passed = rows.filter((r) => r.run.score.pass).length
    console.log(`\n${rows.map((r) => line(r.id, r.run, r.usd)).join('\n')}\nlive ${model}: ${rows.length} of ${cases.length} run, ${passed} passed, spent $${budget.spentUsd.toFixed(3)} of $${cap.toFixed(2)}${budget.stopped ? ' (stopped at the cap)' : ''}`)
    const out = process.env['SX_MIMIR_EVAL_OUT']
    if (out) {
      const at = new Date().toISOString()
      appendFileSync(out, `${JSON.stringify({ at, model, label: process.env['SX_MIMIR_EVAL_LABEL'] ?? '', usd: Math.round(budget.spentUsd * 1000) / 1000, cap, stopped: budget.stopped, cases: rows.map((r) => ({ id: r.id, usd: Math.round(r.usd * 1000) / 1000, ...summary(r.run), turns: r.run.score.turns.detail, ops: r.run.score.ops.detail, sizes: r.run.score.sizes?.detail ?? null, hook: r.run.score.hook?.detail ?? null, calls: r.run.calls, reply: r.run.reply, ...(r.run.error ? { error: r.run.error } : {}) })) })}\n`)
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
      const r = await driveCase(c, { client: budgetedClient(base, model, HAIKU_5_5, budget), model })
      const usd = budget.spentUsd - before
      rows.push({ id: c.id, run: r, usd })
      console.log(line(c.id, r, usd))
      // a run the budget stopped, or one that ended on an error, is not what the model would do: it is never recorded
      if (process.env['SX_MIMIR_EVAL_RECORD'] === '1') recordLive(c.id, r, { model, provider: 'anthropic', stopped: budget.stopped })
    })
  }
})
