// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir build evals: eight parts asked for in one message, six that need a loft or a sweep and two boxy controls,
// run through the tab exactly as the desktop app makes it (test/mimir-build-evals/drive.ts) and scored on the part and
// on the person's turns (score.ts). By default this checks the scoring and replays each recorded case offline, which
// needs the geometry engine (packages/geom/wasm/scripts/build.sh) and skips without it.
//
// A live run asks the model and records nothing unless told to:
//   SX_MIMIR_EVAL=live [SX_MIMIR_EVAL_CASES=id,id] [SX_MIMIR_EVAL_CAP=0.50] [SX_MIMIR_EVAL_RECORD=1]
//   [SX_MIMIR_EVAL_OUT=results.jsonl] [SX_MIMIR_EVAL_LABEL=what changed] vitest run test/mimir-build-evals.test.ts
// with ANTHROPIC_API_KEY in the environment. It runs on Haiku at its published price; no new request starts once the
// spend reaches the cap less the stop margin, and no case starts past it.
import { appendFileSync } from 'node:fs'
import type { PilotEvent } from '@slicerx/contracts'
import { createTransportClient } from '@slicerx/pilot'
import { createNodeTransport } from '@slicerx/pilot/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { budgetedClient, canStart, createBudget, STOP_MARGIN_USD, type Price } from '../../pilot/evals/creative/live'
import { setGeomProvider } from '../src/geom/client'
import { liveEngine, wasmGeom } from './geom-engine'
import { BUILD_CASES } from './mimir-build-evals/cases'
import { driveCase, EVAL_MODEL, tabConfig, type CaseRun } from './mimir-build-evals/drive'
import { loadRecording, saveRecording, type ScoreSummary } from './mimir-build-evals/recordings'
import { classifyNoBuild, extraTurns, okSteps, scoreCase, type UserTurn } from './mimir-build-evals/score'

const live = process.env['SX_MIMIR_EVAL'] === 'live'
/** Haiku 5.5's published price per million tokens, and per hosted web search. */
const HAIKU: Price = { usdIn: 0.1, usdOut: 0.5, usdPerSearch: 0.01, long: { above: 100_000, usdIn: 0.5, usdOut: 2.5 } }

const summary = (r: CaseRun): ScoreSummary => ({ pass: r.score.pass, geometry: r.score.geometry, built: r.score.built, refused: r.score.refused, extra: r.score.extra })

describe('build eval scoring', () => {
  it('reads the 0.2.17 headphone stand reply as turning the part down', () => {
    expect(classifyNoBuild('The curved hook and tapered hollow stem need a swept path and a loft, which this modeler cannot create. I can stack faceted sections instead. Want that?')).toBe('declined')
    expect(classifyNoBuild('What height should the stand be?')).toBe('asked')
    expect(classifyNoBuild('Built the stand.')).toBe('none')
  })

  it('lets one message, one sheet confirm and one Go through, and counts everything else', () => {
    const turns: UserTurn[] = [
      { kind: 'message', text: 'a stand' },
      { kind: 'sheet', title: 'Sizes' },
      { kind: 'go', part: 'Build it?' },
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
  })

  it('has the eight cases, the headphone stand in the words it was turned down with', () => {
    expect(BUILD_CASES.map((c) => c.id)).toEqual(['headphone-stand', 'square-bottle', 'cable-hook', 'mug-handle', 'twisted-vase', 'pipe-elbow', 'pi5-case', 'hinged-box'])
    expect(BUILD_CASES[0]!.prompt).toBe("Design a headphone stand: a round weighted base, a hollow tapered stem, and a curved hook at the top with a soft lip so the headband doesn't slide off. Ask me for the main sizes first.")
    expect(BUILD_CASES.filter((c) => c.control).map((c) => c.id)).toEqual(['pi5-case', 'hinged-box'])
  })

  it('runs the tab on a key for the eval model', () => {
    expect(tabConfig(EVAL_MODEL)).toMatchObject({ provider: 'anthropic', model: EVAL_MODEL })
  })
})

const line = (id: string, r: CaseRun, usd?: number): string => {
  const s = r.score
  const checks = [s.ops, s.watertight, s.bodies, s.minWall, s.bedFit, s.sizes].map((c, i) => (c ? `${['ops', 'closed', 'bodies', 'wall', 'bed', 'size'][i]} ${c.pass ? 'ok' : 'FAIL'} (${c.detail})` : '')).filter(Boolean)
  return `${(s.pass ? 'PASS' : s.refused ? 'REFUSED' : 'FAIL').padEnd(8)} ${id.padEnd(16)} turns ${s.turns.pass ? 'ok' : 'FAIL'} (${s.turns.detail})  ${checks.join('  ')}${usd === undefined ? '' : `  $${usd.toFixed(3)}`}${r.error ? `  error: ${r.error}` : ''}`
}

describe.skipIf(live || !liveEngine)('recorded build eval replies', () => {
  beforeAll(async () => setGeomProvider(await wasmGeom()))
  afterAll(() => setGeomProvider(null))
  for (const c of BUILD_CASES) {
    const rec = loadRecording(c.id)
    it.skipIf(!rec)(`${c.id} scores as it did live`, async () => {
      const r = await driveCase(c, { steps: rec!.steps })
      console.log(line(c.id, r))
      expect(summary(r)).toEqual(rec!.score)
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
      appendFileSync(out, `${JSON.stringify({ at, model, label: process.env['SX_MIMIR_EVAL_LABEL'] ?? '', usd: Math.round(budget.spentUsd * 1000) / 1000, cap, stopped: budget.stopped, cases: rows.map((r) => ({ id: r.id, usd: Math.round(r.usd * 1000) / 1000, ...summary(r.run), turns: r.run.score.turns.detail, ops: r.run.score.ops.detail, sizes: r.run.score.sizes?.detail ?? null, calls: r.run.calls, reply: r.run.reply, ...(r.run.error ? { error: r.run.error } : {}) })) })}\n`)
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
      const r = await driveCase(c, { client: budgetedClient(base, model, HAIKU, budget), model })
      const usd = budget.spentUsd - before
      rows.push({ id: c.id, run: r, usd })
      console.log(line(c.id, r, usd))
      if (process.env['SX_MIMIR_EVAL_RECORD'] === '1' && r.steps.length && !r.error) saveRecording(c.id, { model, provider: 'anthropic', capturedAt: new Date().toISOString(), steps: r.steps, score: summary(r) })
    })
  }
})
