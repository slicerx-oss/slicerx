// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir build evals: fourteen parts asked for in one message, most needing a loft or a sweep, four boxy controls and
// a planter with its saucer asked for as two parts, run through the tab exactly as the desktop app makes it
// (test/mimir-build-evals/drive.ts) and scored on the part and on the person's turns (score.ts). By default this checks
// the scoring, and replays offline each case that has a recording in test/mimir-build-evals/recordings (a case without
// one skips until a live run records it); a replay needs the geometry engine (packages/geom/wasm/scripts/build.sh) and
// skips without it.
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
import { budgetedClient, canStart, createBudget, STOP_MARGIN_USD, type Price } from '../../mcp/evals/creative/live'
import { setGeomProvider } from '../src/geom/client'
import { liveEngine, wasmGeom } from './geom-engine'
import { BUILD_CASES } from './mimir-build-evals/cases'
import { driveCase, EVAL_MODEL, tabConfig, type CaseRun } from './mimir-build-evals/drive'
import { loadRecording, refreshScore, saveRecording, summarize } from './mimir-build-evals/recordings'
import { assemblySizes, classifyNoBuild, extraTurns, hookCheck, okSteps, scoreCase, type UserTurn } from './mimir-build-evals/score'

const live = process.env['SX_MIMIR_EVAL'] === 'live'
/** Haiku 5.5's published price per million tokens, and per hosted web search. */
const HAIKU: Price = { usdIn: 0.1, usdOut: 0.5, usdPerSearch: 0.01, long: { above: 100_000, usdIn: 0.5, usdOut: 2.5 } }

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
    // a boxy control built from solids counts as much as one built from extrudes
    const built: PilotEvent[] = [
      { type: 'tool_call', callId: 'c', tool: 'geom.build', source: 'command', input: {} },
      { type: 'tool_result', callId: 'c', ok: true, summary: 'Built', ms: 1 } as PilotEvent,
    ]
    const box = BUILD_CASES.find((c) => c.id === 'hinged-box')!
    expect(scoreCase(box, { events: built, turns: [], parts: [], firstReply: '', firstBuilt: false, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 }).ops.pass).toBe(true)
  })

  it('has the fourteen cases, the headphone stand in the words of the request', () => {
    expect(BUILD_CASES.map((c) => c.id)).toEqual(['headphone-stand', 'square-bottle', 'cable-hook', 'mug-handle', 'twisted-vase', 'pipe-elbow', 'pi5-case', 'hinged-box', 'flared-vase', 'drawer-handle', 'cable-clip', 'phone-stand-lip', 'planter-saucer', 'coat-hook'])
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
      { kind: 'go', part: 'Build the planter?' },
      { kind: 'sheet', title: 'Saucer' },
      { kind: 'go', part: 'Build the saucer?' },
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

  it('frees a sheet only for a title not seen yet, and a Go only for a part not seen yet', () => {
    const planter = BUILD_CASES.find((c) => c.id === 'planter-saucer')!
    const run = (t: UserTurn[]) => scoreCase(planter, { events: [], turns: t, parts: [], firstReply: '', firstBuilt: false, bed: { shape: 'rectangular', x: 256, y: 256, z: 256 }, wallMm: 0.8 })
    const message: UserTurn = { kind: 'message', text: planter.prompt }
    // the same sheet and Go twice with two parts: the person confirmed the planter twice
    const twice: UserTurn[] = [message, { kind: 'sheet', title: 'Planter' }, { kind: 'go', part: 'Build the planter?' }, { kind: 'sheet', title: 'Planter' }, { kind: 'go', part: 'Build the planter?' }]
    expect(extraTurns(twice, 2).map((t) => t.kind)).toEqual(['sheet', 'go'])
    const scored2 = run(twice)
    expect(scored2.extra).toBe(2)
    expect(scored2.turns.detail).toBe('another sheet, another go')
    // a new title and a new part are free up to the parts asked for
    expect(extraTurns([message, { kind: 'sheet', title: 'Planter' }, { kind: 'sheet', title: 'Saucer' }, { kind: 'go', part: 'Build the planter?' }, { kind: 'go', part: 'Build the saucer?' }], 2)).toEqual([])
    // a third Go, even for a new part, is past the two asked for
    expect(extraTurns([message, { kind: 'go', part: 'a' }, { kind: 'go', part: 'b' }, { kind: 'go', part: 'c' }], 2).map((t) => t.kind)).toEqual(['go'])
    // the boundary: three parts allow three distinct sheets and Gos, and no more
    const three: UserTurn[] = [message, ...['a', 'b', 'c'].flatMap((n): UserTurn[] => [{ kind: 'sheet', title: n }, { kind: 'go', part: n }])]
    expect(extraTurns(three, 3)).toEqual([])
    expect(extraTurns([...three, { kind: 'sheet', title: 'd' }], 3).map((t) => t.kind)).toEqual(['sheet'])
    expect(extraTurns([...three, { kind: 'go', part: 'd' }], 3).map((t) => t.kind)).toEqual(['go'])
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

  it('runs the tab on a key for the eval model', () => {
    expect(tabConfig(EVAL_MODEL)).toMatchObject({ provider: 'anthropic', model: EVAL_MODEL })
  })
})

const line = (id: string, r: CaseRun, usd?: number): string => {
  const s = r.score
  const checks = [s.ops, s.watertight, s.bodies, s.minWall, s.bedFit, s.sizes, s.hook].map((c, i) => (c ? `${['ops', 'closed', 'bodies', 'wall', 'bed', 'size', 'hook'][i]} ${c.pass ? 'ok' : 'FAIL'} (${c.detail})` : '')).filter(Boolean)
  return `${(s.pass ? 'PASS' : s.refused ? 'REFUSED' : 'FAIL').padEnd(8)} ${id.padEnd(16)} turns ${s.turns.pass ? 'ok' : 'FAIL'} (${s.turns.detail})  ${checks.join('  ')}${usd === undefined ? '' : `  $${usd.toFixed(3)}`}${r.error ? `  error: ${r.error}` : ''}`
}

describe.skipIf(live || !liveEngine)('recorded build eval replies', () => {
  beforeAll(async () => setGeomProvider(await wasmGeom()))
  afterAll(() => setGeomProvider(null))
  for (const c of BUILD_CASES) {
    const rec = loadRecording(c.id)
    // a lofted vase with a shell takes about a minute to rebuild in the engine; the drive stops a replay at REPLAY_DRIVE_MS
    // (and says so in r.error), just under the 180 s the test is given
    it.skipIf(!rec)(`${c.id} scores as it did live`, { timeout: 180_000 }, async () => {
      const r = await driveCase(c, { steps: rec!.steps, timeoutMs: REPLAY_DRIVE_MS })
      console.log(line(c.id, r))
      expect(r.error, r.error).toBeUndefined()
      // SX_MIMIR_EVAL_UPDATE_SCORES=1 fills the score fields a recording lacks from this replay; it refuses if the fields it has differ
      if (process.env['SX_MIMIR_EVAL_UPDATE_SCORES'] === '1') refreshScore(c.id, summary(r))
      else expect(summary(r)).toEqual(rec!.score)
      // a known failure fails for its recorded reason
      if (c.id === 'planter-saucer') {
        expect(r.score.bodies, JSON.stringify(r.score.bodies)).toEqual({ pass: false, detail: '1 (want 2 to 2)' })
        // no saucer: one body, and nothing 135 to 150 mm across; the planter itself is closed, prints and fits
        expect(r.score.sizes?.detail).toBe('120 by 120 by 100 mm; off: xy 120 (want 135 to 150)')
        expect([r.score.ops, r.score.watertight, r.score.minWall, r.score.bedFit, r.score.sizes].map((x) => x?.pass)).toEqual([true, true, true, true, false])
        expect(r.score.turns.pass).toBe(true)
      }
      if (c.id === 'drawer-handle') {
        expect(r.score.geometry).toBe(true)
        expect(r.score.turns.detail).toMatch(/^answer /)
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
      const r = await driveCase(c, { client: budgetedClient(base, model, HAIKU, budget), model })
      const usd = budget.spentUsd - before
      rows.push({ id: c.id, run: r, usd })
      console.log(line(c.id, r, usd))
      if (process.env['SX_MIMIR_EVAL_RECORD'] === '1' && r.steps.length && !r.error) saveRecording(c.id, { model, provider: 'anthropic', capturedAt: new Date().toISOString(), steps: r.steps, score: summary(r) })
    })
  }
})
