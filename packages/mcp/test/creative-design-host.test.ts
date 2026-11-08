// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval builds parts with the mimir tab's design tools on a design host of its own: the designs in memory,
// each step replayed on the geometry engine as CAD history. A part built through design.new and geom.extrude replays
// from its history alone to the same body, and a recorded reply that builds with the design tools replays through the
// eval and is scored on that body.
import { IDENTITY, replayHistory, type DesignHost, type HistoryMesh, type Mat4 } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { headlessDesignHost, plainBed } from '../evals/creative/design-host'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { parseRecording } from '../evals/creative/recordings'
import { runPrompt, scoreParts } from '../evals/creative/run'
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

const corner = (parts: { positions: ArrayLike<number> }[]): number[] => {
  const lo = [Infinity, Infinity, Infinity]
  for (const p of parts) for (let i = 0; i + 2 < p.positions.length; i += 3) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k]!, p.positions[i + k]!)
  return lo.map((v) => Math.round(v * 100) / 100)
}

const call = async (tools: ReturnType<typeof tabToolset>, name: string, input: unknown) => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.run(input as never, {} as never)
}

describe('the creative eval design host', () => {
  it('takes a design by its name where its id goes, as the app and MCP hosts do, and lists the ids on a miss', async () => {
    const host = headlessDesignHost(engine)
    const tools = tabToolset(host, createCardPlans(createPlanRegistry()), { nozzleMm: () => 0.4 })
    await call(tools, 'design.new', { name: 'Hinged box' })
    expect(host.get('hinged  box').id).toBe('d1')
    expect(() => host.get('Lid')).toThrow(/no design Lid; give a design id, such as d1 \(Hinged box\)/)
  })

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
        // built on the bed, so it stays where it was built and the cut lands on it
        { calls: [{ name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 100, heightMm: 30 }, placement: { center: [60, 20] }, distance_mm: 20 } }] },
        { calls: [{ name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 96, heightMm: 26 }, placement: { center: [60, 20] }, frame: { origin: [0, 0, 20], normal: [0, 0, 1] }, distance_mm: 18, operation: 'cut' } }] },
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
    // it stayed where it was built (10 to 110 by 5 to 35 mm), and the cut hollowed it: more than a box's 12 triangles
    expect(corner(run.parts)).toEqual([10, 5, 0])
    expect(run.parts.reduce((n, p) => n + p.indices.length / 3, 0)).toBeGreaterThan(12)
    expect(run.parsed.detail).not.toMatch(/moved/)
  })

  it('marks a recording from before the tab tools stale', async () => {
    if (recorded.status !== 'recorded') throw new Error('recorded')
    const run = await runPrompt(P, { geom: undefined, steps: [{ calls: [{ name: 'text_to_part', args: { prompt: 'a tray' } }] }, { text: 'Done.' }], answerRecorded: true })
    expect(run.stale).toMatch(/design tools/)
    expect(run.calls).toEqual(['text_to_part'])
  })
})

describe('a reply that builds the part again as a new design', () => {
  const P = CREATIVE_PROMPTS.find((x) => x.id === 'spinner-ring')!
  // a tube of `outer` and `inner` diameter, 8 mm tall, as a new body of `design` centered at `at`
  const tube = (design: string, name: string, outer: number, inner: number, at: [number, number]) => ({
    name: 'geom.extrude',
    args: { design, name, distance_mm: 8, extent: 'oneSide', operation: 'new', frame: { origin: [...at, 0], normal: [0, 0, 1] }, shape: { type: 'sketch', loops: [{ type: 'circle', center: [0, 0], diameterMm: outer }, { type: 'circle', center: [0, 0], diameterMm: inner }] } },
  })
  // the end of the reply a live run gave after its first try failed the check and it built a second design
  const REPLY =
    'The spinner ring is built as "Spinner ring v2" in the project, with the core and band as two separate bodies that print in place. ' +
    'The first attempt (the plan\'s formal check, plan_1) failed. The groove on the core came out at the wrong radius, so the band\'s lip touched the core at one point and the two printed fused. ' +
    'I rebuilt both bodies as turned profiles with the same sizes. The fit check on the rebuilt version passes: two pieces, 0.40 mm clearance at the narrowest point, and the band slides freely. ' +
    'The original "Spinner ring" design is still open in the project and should be deleted, since it has the bad groove.'
  const steps = [
    { calls: [{ name: 'pilot.sheet', args: { title: 'Spinner ring', dims: [{ key: 'inner', label: 'Inner diameter', value: 19, unit: 'mm', source: 'asked' }] } }] },
    // the first try: the band overlaps the core, so the two print as one piece
    { calls: [{ name: 'design.new', args: { name: 'Spinner ring' } }, tube('d1', 'Core', 24, 19, [128, 128])] },
    { calls: [tube('d1', 'Band', 29.8, 23, [128, 128])] },
    // the second try, a new design beside it: the band clears the core by 0.4 mm
    { calls: [{ name: 'design.new', args: { name: 'Spinner ring v2' } }, tube('d2', 'Core', 24, 19, [60, 60])] },
    { calls: [tube('d2', 'Band', 29.8, 24.8, [60, 60])] },
    { text: REPLY },
  ]

  it('scores only the last design, not the first try left beside it', async () => {
    const run = await runPrompt(P, { geom: { run: (op, input) => engine(op, input) }, steps, answerRecorded: true, tabTools: true })
    expect(run.error).toBeUndefined()
    expect(run.reply).toContain('Spinner ring v2')
    expect(run.parsed).toEqual({ pass: true, detail: '2 designs, scored the last (d2): 2 feature steps, 2 mesh parts' })
    expect(size(run.parts)).toEqual([29.8, 29.8, 8])
    const score = scoreParts(P, run.parsed, run.parts, run.gaps)
    // both designs together would be 4 bodies with the first try's band fused to its core
    expect(score.bodies).toEqual({ pass: true, detail: '2 (want 2 to 3)' })
    expect(score.clearance?.pass).toBe(true)
    expect(score.clearance?.detail).toMatch(/^0\.4 mm side gap over 1 pair/)
    expect(score.pass).toBe(true)
  })
})

/** A box from `min` to `max`, as a part. */
function box(min: number[], max: number[]): HistoryMesh {
  const [x0, y0, z0] = min as [number, number, number]
  const [x1, y1, z1] = max as [number, number, number]
  const positions = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { name: 'box', slot: 1, positions, indices }
}

const at = (x: number, y: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]

describe('the eval bed (plainBed)', () => {
  const square = { widthMm: 256, depthMm: 256, heightMm: 256 }
  const none = () => []

  it('takes a part on the bed and between the bed and the printable height as printing where it stands', () => {
    const bed = plainBed(square, none)
    expect(bed.printsOnBed([box([10, 10, 0], [50, 50, 20])], [...IDENTITY])).toBe(true)
    expect(bed.printsOnBed([box([-5, 10, 0], [50, 50, 20])], [...IDENTITY])).toBe(false)
    expect(bed.printsOnBed([box([10, 10, -1], [50, 50, 20])], [...IDENTITY])).toBe(false)
    // taller than the printable height: it does not print where it stands, and landing moves it but cannot lower it
    expect(bed.printsOnBed([box([10, 10, 0], [50, 50, 300])], [...IDENTITY])).toBe(false)
    expect(bed.landOnBed([box([10, 10, 0], [50, 50, 300])], [...IDENTITY])).toEqual(at(98, 98))
  })

  it('lands a part in the middle of the bed, 5 mm clear of the edge', () => {
    const bed = plainBed(square, none)
    expect(bed.landOnBed([box([-20, -10, 0], [20, 10, 5])], [...IDENTITY])).toEqual(at(128, 128))
    expect(bed.landOnBed([box([0, 0, 0], [250, 10, 5])], [...IDENTITY])).toBeNull()
  })

  it('on a round bed, lands a part in the middle of the circle and refuses a box whose corners leave it', () => {
    const round = { widthMm: 200, depthMm: 200, heightMm: 200, round: true }
    const bed = plainBed(round, none)
    expect(bed.printsOnBed([box([0, 0, 0], [20, 20, 5])], [...IDENTITY])).toBe(false)
    expect(bed.printsOnBed([box([90, 90, 0], [110, 110, 5])], [...IDENTITY])).toBe(true)
    expect(bed.landOnBed([box([0, 0, 0], [20, 20, 5])], [...IDENTITY])).toEqual(at(90, 90))
    // 150 mm square: its corners are 106 mm from the middle of a 100 mm circle
    expect(bed.landOnBed([box([0, 0, 0], [150, 150, 5])], [...IDENTITY])).toBeNull()
  })

  it('has no spot for a part whose middle another design takes: the gap where the app would look for a free spot', () => {
    const bed = plainBed(square, () => [{ parts: [box([108, 108, 0], [148, 148, 10])], transform: [...IDENTITY] }])
    expect(bed.landOnBed([box([-10, -10, 0], [10, 10, 5])], [...IDENTITY])).toBeNull()
  })
})

describe('the eval host lands bodies on the bed', () => {
  const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }
  function landing() {
    const host: DesignHost = headlessDesignHost(engine, { bed: (id) => plainBed(BED, () => host.list().filter((d) => d.id !== id && d.parts.length)) })
    return { host, tools: tabToolset(host, createCardPlans(createPlanRegistry())) }
  }
  const rect = (design: string, w: number, h: number, center: [number, number], more: Record<string, unknown> = {}) => ({ design, shape: { type: 'rectangle', widthMm: w, heightMm: h }, placement: { center }, distance_mm: 5, ...more })
  const landedOf = (out: unknown): string | undefined => (out as { output?: { landed?: string } }).output?.landed

  it('lands a part again when an edit takes it past the edge, and says so only in that reply', async () => {
    const { host, tools } = landing()
    await call(tools, 'design.new', { name: 'Block' })
    expect(landedOf(await call(tools, 'geom.extrude', rect('d1', 20, 20, [128, 128])))).toBeUndefined()
    const joined = await call(tools, 'geom.extrude', rect('d1', 140, 20, [200, 128], { operation: 'join', part: 0 }))
    expect(landedOf(joined)).toBe('Block did not fit on the bed where it stood, so it moved by (-66, 0) mm.')
    expect(host.get('d1').transform).toEqual(at(-66, 0))
    expect(host.get('d1').landed).toBeUndefined()
    const listed = (await call(tools, 'design.list', {})) as { output: { designs: { landed?: string }[] } }
    expect(listed.output.designs[0]!.landed).toBeUndefined()
  })

  it('leaves a part with no room where it was built, and an edit then leaves it parked', async () => {
    const { host, tools } = landing()
    await call(tools, 'design.new', { name: 'Long bar' })
    const built = await call(tools, 'geom.extrude', rect('d1', 300, 20, [0, 0]))
    expect(landedOf(built)).toBe('The part does not fit on the bed anywhere, so it stays where it was built, off the bed.')
    expect(host.get('d1').transform).toEqual([...IDENTITY])
    const edited = await call(tools, 'geom.extrude', rect('d1', 20, 20, [0, 10], { operation: 'join', part: 0 }))
    expect(landedOf(edited)).toBe('Long bar is off the bed, so it stays where it is. Move it onto the bed to print it.')
    expect(host.get('d1').transform).toEqual([...IDENTITY])
  })

  it('leaves a second design where it was built when the first takes the middle (the app would find a free spot)', async () => {
    const { host, tools } = landing()
    await call(tools, 'design.new', { name: 'First' })
    await call(tools, 'geom.extrude', rect('d1', 40, 40, [128, 128]))
    await call(tools, 'design.new', { name: 'Second' })
    const second = await call(tools, 'geom.extrude', rect('d2', 20, 20, [0, 0]))
    expect(landedOf(second)).toBe('The part does not fit on the bed anywhere, so it stays where it was built, off the bed.')
    expect(host.get('d2').transform).toEqual([...IDENTITY])
  })

  it('puts the base back when every step is undone, without landing it', async () => {
    const { host, tools } = landing()
    const made = await host.create('Plate', [box([100, 100, 0], [120, 120, 5])])
    expect(made.landed).toBeUndefined()
    await call(tools, 'geom.extrude', rect(made.id, 140, 20, [200, 110]))
    const moved = host.get(made.id).transform
    expect(moved).not.toEqual([...IDENTITY])
    const undone = await call(tools, 'design.undo', { design: made.id })
    expect(landedOf(undone)).toBeUndefined()
    expect(host.get(made.id).transform).toEqual(moved)
    expect(host.get(made.id).history.steps).toHaveLength(0)
  })
})
