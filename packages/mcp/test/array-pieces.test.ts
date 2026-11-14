// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pieces made by geom.array as separate copies: the copies are new parts named for the part copied with a number
// ("Segment 1 2"), so a plan naming them "Segment 2" or "Planet 2" can only match through what the array step records,
// the part it copied and each copy's place in the row. The plans and body names are the ones a live run of the mimir
// tab sent and got back (an articulated lizard and a planetary gear). The engine's fit check reply is built here from
// the meshes: one body per part, each next to the one after it in the row.
import { historyFiles, parseHistories, type Design as HostDesign, type DesignHost, type HistoryMesh, type Step, type StepParams } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { fitItems, type BodyFacts } from '../src/design-check'
import { fitFacts, fitLimits } from '../src/fit-facts'
import { modelingTools } from '../src/modeling-tools'
import type { ToolContext } from '@slicerx/pilot'

type V3 = [number, number, number]
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const PITCH = 16.3
const limits = fitLimits({ nozzleMm: 0.4, layerHeightMm: 0.2, material: 'PLA' })

// a 15.92 mm block per part, the next one PITCH along x: 0.38 mm between neighbors, as the lizard's second check measured
const block = (name: string, k: number): HistoryMesh => {
  const x0 = k * PITCH
  const x1 = x0 + PITCH - 0.38
  return { name, slot: 0, positions: [x0, 0, 0, x1, 0, 0, x1, 20, 0, x0, 20, 0, x0, 0, 6, x1, 0, 6, x1, 20, 6, x0, 20, 6], indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] }
}

let ids = 0
const step = (params: StepParams): Step => ({ id: `s${++ids}`, part: -1, transform: IDENTITY, params })
const add = (parts: HistoryMesh[], label: string, arrayOf?: string): Step => step({ op: 'parts.add', parts, label, ...(arrayOf ? { arrayOf } : {}) })

/** A design whose parts are the given ones, in that order, made by the given steps. */
const designOf = (parts: HistoryMesh[], steps: Step[]): HostDesign => ({ id: 'd1', name: 'Mechanism', history: { version: 1, base: [], steps }, transform: IDENTITY, parts, status: steps.map(() => ({ state: 'done' })), madeBy: {}, redo: [] }) as unknown as HostDesign

/** The fit check's reply from the meshes: one body per part, a gap from each to the next (a touch where `touch` says so). */
function engine(touch: ReadonlySet<number> = new Set()): DesignHost {
  return {
    call: async (op: string, req: { meshes: { positions: number[] }[] }) => {
      if (op !== 'fit.check') throw new Error(`no ${op} here`)
      const bounds = req.meshes.map((m) => {
        const xs = m.positions.filter((_, i) => i % 3 === 0)
        return { min: [Math.min(...xs), 0, 0] as V3, max: [Math.max(...xs), 20, 6] as V3 }
      })
      const gaps = bounds.slice(1).map((b, k) => {
        const gapMm = touch.has(k) ? 0 : Math.round((b.min[0] - bounds[k]!.max[0]) * 1000) / 1000
        return { parts: [k, k + 1], gapMm, limitMm: limits.sideMm, kind: touch.has(k) ? 'fused' : 'apart', from: [bounds[k]!.max[0], 8.2, 0], to: [bounds[k]!.max[0] + gapMm, 8.2, 0] }
      })
      return { parts: bounds.map((b, item) => ({ bounds: b, item })), gaps, pieces: bounds.length - touch.size }
    },
  } as unknown as DesignHost
}

/** The copies the design's array steps recorded, by name (what fit facts reads). */
const arrayCopiesOf = (d: HostDesign): string[] => d.history.steps.flatMap((s) => (s.params.op === 'parts.add' && typeof s.params.arrayOf === 'string' ? [s.params.arrayOf] : []))

const piecesOf = async (d: HostDesign, plan: string[], touch?: ReadonlySet<number>) => {
  const fit = await fitFacts(engine(touch), d, limits)
  const items = fitItems(plan, { fit } as BodyFacts)
  return { fit, pieces: items.find((i) => i.name === 'pieces')!, gaps: items.find((i) => i.name === 'gaps')! }
}

const segments = (n: number): string[] => Array.from({ length: n }, (_, k) => `Segment ${k + 1}`)

/** The lizard as built: Segment 1 from geom.build, then geom.array of 9 as separate copies, Segment 1 2 to Segment 1 9. */
function lizard(copies = 9, drop: number[] = []) {
  const first = block('Segment 1', 0)
  const made = Array.from({ length: copies - 1 }, (_, k) => block(`Segment 1 ${k + 2}`, k + 1))
  const steps = [add([first], 'Add Segment 1'), add(made, `Array of ${copies}, separate`, 'Segment 1')]
  return designOf([first, ...made].filter((_, k) => !drop.includes(k)), steps)
}

describe('pieces made as separate array copies', () => {
  it('passes the lizard: Segment 1 to Segment 9 planned, the array made Segment 1 and Segment 1 2 to Segment 1 9', async () => {
    const plan = segments(9)
    const { fit, pieces, gaps } = await piecesOf(lizard(), plan)
    expect(fit.bodies.map((b) => b.name)).toEqual(['Segment 1', 'Segment 1 2', 'Segment 1 3', 'Segment 1 4', 'Segment 1 5', 'Segment 1 6', 'Segment 1 7', 'Segment 1 8', 'Segment 1 9'])
    expect(fit.bodies.map((b) => b.array)).toEqual([{ of: 'Segment 1', n: 1 }, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ of: 'Segment 1', n }))])
    expect(pieces.want).toBe('9 separate pieces (Segment 1, Segment 2, Segment 3, Segment 4, Segment 5, Segment 6, Segment 7, Segment 8, Segment 9)')
    expect(pieces.pass).toBe(true)
    expect(pieces.got).toBe('9 pieces (Segment 2, Segment 3, Segment 4, Segment 5, Segment 6, Segment 7, Segment 8 and Segment 9 are Segment 1 2, Segment 1 3, Segment 1 4, Segment 1 5, Segment 1 6, Segment 1 7, Segment 1 8 and Segment 1 9, in the array of Segment 1)')
    expect(gaps.pass).toBe(true)
  })

  it('passes the planetary gear: Planet 2 and Planet 3 are the copies Planet 1 2 and Planet 1 3', async () => {
    const sun = block('Sun gear', 0)
    const planet = block('Planet 1', 1)
    const copies = [block('Planet 1 2', 2), block('Planet 1 3', 3)]
    const ring = block('Ring gear', 4)
    const d = designOf([sun, planet, ...copies, ring], [add([sun, planet], 'Add Sun gear and Planet 1'), add(copies, 'Array of 3, separate', 'Planet 1'), add([ring], 'Add Ring gear')])
    const { fit, pieces } = await piecesOf(d, ['Sun gear', 'Planet 1', 'Planet 2', 'Planet 3', 'Ring gear'])
    expect(fit.bodies.map((b) => b.name)).toEqual(['Sun gear', 'Planet 1', 'Planet 1 2', 'Planet 1 3', 'Ring gear'])
    expect(pieces.pass).toBe(true)
    expect(pieces.got).toBe('5 pieces (Planet 2 and Planet 3 are Planet 1 2 and Planet 1 3, in the array of Planet 1)')
  })

  it('numbers the copies of a part with no number of its own from the part itself, which is copy 1', async () => {
    const foot = block('Foot', 0)
    const copies = [block('Foot 2', 1), block('Foot 3', 2)]
    const d = designOf([foot, ...copies], [add([foot], 'Add Foot'), add(copies, 'Array of 3, separate', 'Foot')])
    const { pieces } = await piecesOf(d, ['Foot 1', 'Foot 2', 'Foot 3'])
    expect(pieces.pass).toBe(true)
    expect(pieces.got).toBe('3 pieces (Foot 1 is Foot, in the array of Foot)')
  })

  it('still fails parts that only look like copies: no array step made them', async () => {
    const parts = segments(9).map((_, k) => block(k ? `Segment 1 ${k + 1}` : 'Segment 1', k))
    const d = designOf(parts, [add(parts, 'Add segments')])
    const { pieces } = await piecesOf(d, segments(9))
    expect(pieces.pass).toBe(false)
    expect(pieces.got).toContain('Segment 2, Segment 3, Segment 4, Segment 5, Segment 6, Segment 7, Segment 8 and Segment 9 are not among them')
  })

  it('fails a copy merged into another: Segment 1 3 joined into Segment 1 2 leaves 8 pieces', async () => {
    const { pieces } = await piecesOf(lizard(9, [2]), segments(9))
    expect(pieces.pass).toBe(false)
    expect(pieces.got).toBe('8 pieces: Segment 3 is not a body of its own; keep each piece as a separate body')
  })

  it('fails a copy that touches the next one: 9 bodies print as 8 pieces', async () => {
    const { pieces } = await piecesOf(lizard(), segments(9), new Set([3]))
    expect(pieces.pass).toBe(false)
    expect(pieces.got).toBe('8 pieces: Segment 1 4 and Segment 1 5 touch at (64.8, 8.2, 0), so they print as one piece; leave the planned gap between them')
  })

  it('fails a missing copy: an array of 8 for 9 planned segments', async () => {
    const { pieces } = await piecesOf(lizard(8), segments(9))
    expect(pieces.pass).toBe(false)
    expect(pieces.got).toBe('8 pieces: Segment 9 is not a body of its own; keep each piece as a separate body')
  })

  it('fails a merged copy even when a loose body brings the count back to 9', async () => {
    const d = lizard(9, [2])
    const tail = block('Tail', 9)
    d.parts.push(tail)
    d.history.steps.push(add([tail], 'Add Tail'))
    const { pieces } = await piecesOf(d, segments(9))
    expect(pieces.pass).toBe(false)
    expect(pieces.got).toContain('Segment 3 is not among them')
  })

  it('reads no copy from an array step that is suppressed, or from a part another shares the name of', async () => {
    const off = lizard()
    off.history.steps[1]!.suppressed = true
    expect((await piecesOf(off, segments(9))).fit.bodies.some((b) => b.array)).toBe(false)
    // a second Segment 1 2 from elsewhere: which one the array made is not known, so neither answers Segment 2
    const twice = lizard()
    twice.parts.push(block('Segment 1 2', 9))
    const { fit, pieces } = await piecesOf(twice, [...segments(9), 'Spare'])
    expect(fit.bodies.filter((b) => b.name.startsWith('Segment 1 2')).map((b) => b.array)).toEqual([undefined, undefined])
    expect(pieces.pass).toBe(false)
  })

  it('geom.array with merge false records the part it copied on the step that adds the copies', async () => {
    const seg = block('Segment 1', 0)
    const d = designOf([seg], [add([seg], 'Add Segment 1')])
    const added: { part: number; params: StepParams }[] = []
    const host = {
      get: () => d,
      // the engine's array reply: a transform per copy, the first the part itself
      call: async (op: string) => {
        if (op !== 'array') throw new Error(`no ${op} here`)
        return { transforms: [0, 1, 2].map((k) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, k * PITCH, 0, 0, 1]) }
      },
      add: async (_d: HostDesign, part: number, params: StepParams) => {
        added.push({ part, params })
      },
    } as unknown as DesignHost
    const tool = modelingTools({ files: { call: async () => ({}), mesh: async () => ({ stlPath: '' }) }, designs: host }).find((t) => t.name === 'geom.array')!
    await tool.run(tool.input.parse({ design: 'd1', part: 0, spec: { kind: 'linear', count: 3, step: [PITCH, 0, 0] }, merge: false }), {} as ToolContext)
    expect(added).toHaveLength(1)
    const p = added[0]!.params as Extract<StepParams, { op: 'parts.add' }>
    expect(p.op).toBe('parts.add')
    expect(p.arrayOf).toBe('Segment 1')
    expect(p.parts.map((m) => m.name)).toEqual(['Segment 1 2', 'Segment 1 3'])
  })

  it('geom.array records the part it copied only by a name the project file keeps, 120 characters at most', async () => {
    const recorded = async (name: string) => {
      const seg = block(name, 0)
      const d = designOf([seg], [add([seg], 'Add it')])
      const added: StepParams[] = []
      const host = {
        get: () => d,
        call: async () => ({ transforms: [0, 1].map((k) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, k * PITCH, 0, 0, 1]) }),
        add: async (_d: HostDesign, _part: number, params: StepParams) => {
          added.push(params)
        },
      } as unknown as DesignHost
      const tool = modelingTools({ files: { call: async () => ({}), mesh: async () => ({ stlPath: '' }) }, designs: host }).find((t) => t.name === 'geom.array')!
      await tool.run(tool.input.parse({ design: 'd1', part: 0, spec: { kind: 'linear', count: 2, step: [PITCH, 0, 0] }, merge: false }), {} as ToolContext)
      return added[0] as Extract<StepParams, { op: 'parts.add' }>
    }
    expect((await recorded('x'.repeat(120))).arrayOf).toBe('x'.repeat(120))
    // an imported part's long name: the copies are still made, with no link a reopened project would drop
    const long = await recorded('y'.repeat(121))
    expect(long.parts).toHaveLength(1)
    expect('arrayOf' in long).toBe(false)
  })
})

describe('geom.array copies of a part whose name has edges', () => {
  type Added = Extract<StepParams, { op: 'parts.add' }>
  /** geom.array with separate copies of a part by this name, as the tool runs it: the design it leaves, and the step it recorded. */
  async function arrayed(name: string, count = 3) {
    const seg = block(name, 0)
    const d = designOf([seg], [add([seg], 'Add it')])
    const host = {
      get: () => d,
      call: async () => ({ transforms: Array.from({ length: count }, (_, k) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, k * PITCH, 0, 0, 1]) }),
      // as the design store does: the step is kept and its parts join the design
      add: async (_d: HostDesign, _part: number, params: StepParams) => {
        d.history.steps.push(step(params))
        d.status.push({ state: 'done' } as HostDesign['status'][number])
        if (params.op === 'parts.add') d.parts.push(...params.parts)
      },
    } as unknown as DesignHost
    const tool = modelingTools({ files: { call: async () => ({}), mesh: async () => ({ stlPath: '' }) }, designs: host }).find((t) => t.name === 'geom.array')!
    await tool.run(tool.input.parse({ design: 'd1', part: 0, spec: { kind: 'linear', count, step: [PITCH, 0, 0] }, merge: false }), {} as ToolContext)
    return { d, recorded: d.history.steps[1]!.params as Added }
  }
  /** The design as a saved project gives it back: its steps through the project file, its parts as they were. */
  function reopened(d: HostDesign): HostDesign {
    const files = new Map(historyFiles([{ id: 'o1', history: d.history }], new Map([['o1', 1]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    return { ...d, history: parseHistories(files, new Set(['1'])).get('1')! }
  }

  it('records no part copied for a name of blank space, though the copies are made', async () => {
    for (const name of ['   ', '\t', ' \n ']) {
      const { d, recorded } = await arrayed(name)
      expect(recorded.parts, JSON.stringify(name)).toHaveLength(2)
      expect('arrayOf' in recorded, JSON.stringify(name)).toBe(false)
      expect(arrayCopiesOf(d), JSON.stringify(name)).toEqual([])
    }
  })

  it('matches the copies of a part named with space before or after it, saved and reopened too', async () => {
    for (const name of ['  Segment 1', 'Segment 1  ', '  Segment 1 ']) {
      const { d, recorded } = await arrayed(name)
      // kept as written; the copies are named from it as written
      expect(recorded.arrayOf, JSON.stringify(name)).toBe(name)
      expect(recorded.parts.map((m) => m.name)).toEqual([`${name} 2`, `${name} 3`])
      for (const [what, design] of [['as made', d], ['reopened', reopened(d)]] as const) {
        const { fit, pieces } = await piecesOf(design, segments(3))
        expect(fit.bodies.map((b) => b.array), `${JSON.stringify(name)} ${what}`).toEqual([{ of: name, n: 1 }, { of: name, n: 2 }, { of: name, n: 3 }])
        expect(pieces.pass, `${JSON.stringify(name)} ${what}`).toBe(true)
      }
    }
  })

  it('names the copies of a part of 120 characters 122 characters long, which still match, saved and reopened too', async () => {
    // 118 characters and " 1": the plan's own name for copy 2 is 118 characters and " 2", which only the array step gives
    const base = 'a'.repeat(118)
    const name = `${base} 1`
    expect(name).toHaveLength(120)
    const { d, recorded } = await arrayed(name)
    expect(recorded.arrayOf).toBe(name)
    expect(recorded.parts.map((m) => m.name)).toEqual([`${name} 2`, `${name} 3`])
    expect(recorded.parts.map((m) => m.name.length)).toEqual([122, 122])
    const plan = [1, 2, 3].map((n) => `${base} ${n}`)
    for (const [what, design] of [['as made', d], ['reopened', reopened(d)]] as const) {
      const { fit, pieces } = await piecesOf(design, plan)
      expect(fit.bodies.map((b) => b.array), what).toEqual([{ of: name, n: 1 }, { of: name, n: 2 }, { of: name, n: 3 }])
      expect(pieces.pass, what).toBe(true)
    }
  })
})

describe('the array tool', () => {
  it('is at 1.9.2, since it repeats chosen design steps on their part, a row can follow a curved side, copies that miss are left out, it reads back which copies landed, and a step repeated with its own row is made once in each copy', () => {
    const tool = modelingTools({ files: { call: async () => ({}), mesh: async () => ({ stlPath: '' }) } }).find((t) => t.name === 'geom.array')!
    expect(tool.version).toBe('1.9.2')
  })
})
