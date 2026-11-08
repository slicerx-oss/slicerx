// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design a sketch is drawn for and used on. Every tool that reads a finished sketch for a design asks the host for
// it in that design's frame, and every tool that puts a sketch in the timeline tells the host the design it is drawn
// for. With none named, a sketch is the plate's while no design was moved onto the bed; after that it is the only
// design's, or refused. The change file's versions are the tools' own.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Design, DesignHost, SketchItem } from '@slicerx/cad-history'
import { describe, expect, it, vi } from 'vitest'
import { cadTools, wireSketchVia, type SketchVia } from '../src/cad'
import { paintTools } from '../src/paint'
import { designToolset, NO_CAD_FILES, NO_ENGINE_HOST } from '../src/toolset'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const SQUARE = [{ points: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][] }]
const TRACED = { loops: SQUARE, counts: { lines: 4, arcs: 0, splines: 0, circles: 0 }, sizeMm: [10, 10], mmPerPx: 0.1, imagePx: [100, 100], workingPx: [100, 100], dropped: { specks: 0, holes: 0 }, check: { ok: true, areaMm2: 100, loops: [], issues: [] }, warnings: [], mode: 'dark' }

function design(id: string, placed?: [number, number]): Design {
  return { id, name: id === 'd1' ? 'Stand' : 'Peg', history: { version: 1, base: [], steps: [] }, transform: I, ...(placed ? { placed } : {}), parts: [], status: [], madeBy: {}, redo: [] }
}

function host(designs: Design[]) {
  const sketches: SketchItem[] = []
  const read: [string, string | undefined][] = []
  const added: (string | undefined)[] = []
  const engine = vi.fn(async (op: string, _req?: unknown) => (op === 'sketch.svg' ? { loops: SQUARE, counts: TRACED.counts, sizeMm: [10, 10], mmPerUnit: 1, check: TRACED.check, warnings: [] } : TRACED))
  const h: DesignHost = {
    ...NO_ENGINE_HOST,
    get: (id) => designs.find((d) => d.id === id) ?? designs[0]!,
    list: () => designs,
    add: async (d, part, params, _l, opts) => {
      const step = { id: `s${d.history.steps.length}`, part, transform: I, params, ...(opts?.sketch ? { sketch: opts.sketch } : {}) }
      d.history = { ...d.history, steps: [...d.history.steps, step] }
      return step
    },
    call: engine as DesignHost['call'],
    bed: () => ({ widthMm: 256, depthMm: 256 }),
    sketch: (id, d) => {
      read.push([id, d])
      return sketches.find((k) => k.id === id)!
    },
    addSketch: (s, d) => {
      added.push(d)
      const k: SketchItem = { kind: 'sketch', id: `k${sketches.length + 1}`, name: `Sketch ${sketches.length + 1}`, ...s }
      sketches.push(k)
      return k
    },
  }
  const tools = designToolset(h)
  const run = (name: string, input: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!
    return t.run(t.input.parse(input) as never, {} as never)
  }
  return { run, read, added, engine, h }
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

describe('the design a sketch is drawn for and used on', () => {
  it('reads each finished sketch in the frame of the design it is used on, in every tool that takes one', async () => {
    const { run, read } = host([design('d1', [128, 128])])
    for (let n = 0; n < 2; n++) await run('design.sketch', { design: 'd1', loops: SQUARE })
    await run('geom.extrude', { design: 'd1', sketch: 'k1', distance_mm: 2 })
    await run('geom.revolve', { design: 'd1', sketch: 'k1', axis: { point: [-5, 0], direction: [0, 1] } })
    await run('geom.loft', { design: 'd1', sketches: ['k1', 'k2'] })
    await run('geom.sweep', { design: 'd1', profile_sketch: 'k1', path_sketch: 'k2' })
    // design.sketch reads back the one it made in the frame it was drawn in; the rest read for the design they act on
    expect(read.filter(([, d]) => d !== 'd1')).toEqual([])
    expect(read.map(([k]) => k)).toEqual(['k1', 'k1', 'k1', 'k2', 'k1', 'k2'])
  })

  it('tells the host the design each new sketch is drawn for, and centers SVG and traces on the bed in its frame', async () => {
    const { run, added, engine } = host([design('d1', [128, 100])])
    await run('design.sketch', { design: 'd1', loops: SQUARE })
    await run('design.sketch_svg', { design: 'd1', svg })
    await run('design.trace_image', { design: 'd1', image: { base64: 'AA' } })
    expect(added).toEqual(['d1', 'd1', 'd1'])
    // the bed's middle (128, 128) less the design's landing
    expect(engine.mock.calls.find(([op]) => op === 'sketch.svg')![1]).toMatchObject({ options: { center: [0, 28] } })
    expect(engine.mock.calls.find(([op]) => op === 'sketch.trace')![1]).toMatchObject({ options: { center: [0, 28] } })
  })

  it('centers an SVG or a trace with no design named on the bed\'s middle, drawn for the one design moved onto the bed', async () => {
    const { run, added, engine } = host([design('d1', [128, 100])])
    await run('design.sketch_svg', { svg })
    await run('design.trace_image', { image: { base64: 'AA' } })
    expect(added).toEqual(['d1', 'd1'])
    // in the design's frame, the bed's middle (128, 128) less its landing, so on the plate it is the bed's middle
    expect(engine.mock.calls.find(([op]) => op === 'sketch.svg')![1]).toMatchObject({ options: { center: [0, 28] } })
    expect(engine.mock.calls.find(([op]) => op === 'sketch.trace')![1]).toMatchObject({ options: { center: [0, 28] } })
  })

  /** A trace routed to the app's design.sketch, over `via`: the engine requests and the args it sent on. */
  async function routed(via: SketchVia, input: Record<string, unknown>) {
    const engine = vi.fn(async (_op: string, _req: unknown) => TRACED)
    const sent: Record<string, unknown>[] = []
    via.run = async (args) => (sent.push(args), { summary: 'Sketch 3', output: { id: 'k3', name: 'Sketch 3', in: 'app' } })
    const h: DesignHost = { ...NO_ENGINE_HOST, call: engine as DesignHost['call'] }
    const tool = cadTools({ files: NO_CAD_FILES, designs: h, sketchVia: via }).find((t) => t.name === 'design.trace_image')!
    await tool.run(tool.input.parse({ image: { base64: 'AA' }, ...input }) as never, {} as never)
    return { center: (engine.mock.calls[0]![1] as { options: { center: unknown } }).options.center, sent }
  }

  it('sends the design on with a trace routed to the app, centered by the landing the app reports', async () => {
    const via: SketchVia = { bedMiddle: async () => [128, 128], drawnFor: async (d) => (d === 'obj_app' ? { design: 'obj_app', placed: [100, 28] } : undefined) }
    const r = await routed(via, { design: 'obj_app' })
    expect(r.center).toEqual([28, 100])
    expect(r.sent).toEqual([{ loops: SQUARE, design: 'obj_app' }])
  })

  it('reads the app\'s designs for a routed trace: by id, by name, the one moved onto the bed when none is named, and none when the link fails', async () => {
    const designs = [{ design: 'obj_a', name: 'Stand', placedMm: [100, 28] }]
    const answers: Record<string, unknown> = { 'plate.list': { bed: { widthMm: 256, depthMm: 256 } }, 'design.list': { output: { designs } } }
    const via: SketchVia = {}
    wireSketchVia(via, [], { call: async <T,>(m: string) => answers[m] as T })
    expect(await via.drawnFor!('obj_a')).toEqual({ design: 'obj_a', placed: [100, 28] })
    expect(await via.drawnFor!('Stand')).toEqual({ design: 'obj_a', placed: [100, 28] })
    expect(await via.drawnFor!(undefined)).toEqual({ design: 'obj_a', placed: [100, 28] })
    expect(await routed(via, {})).toEqual({ center: [28, 100], sent: [{ loops: SQUARE, design: 'obj_a' }] })
    // with a design that waits as well, none is picked for an unnamed trace: the app's design.sketch refuses it
    designs.push({ design: 'obj_b', name: 'Peg' } as never)
    expect(await via.drawnFor!(undefined)).toBeUndefined()
    // a link that fails leaves the trace on the plate's coordinates
    const down: SketchVia = {}
    wireSketchVia(down, [], { call: async () => Promise.reject(new Error('link off')) })
    expect(await down.drawnFor!('obj_a')).toBeUndefined()
  })

  it('draws a sketch with no design named on the plate, then for the only design once it landed, else refuses', async () => {
    const plain = host([design('d1'), design('d2')])
    await plain.run('design.sketch', { loops: SQUARE })
    expect(plain.added).toEqual([undefined])
    const one = host([design('d1', [128, 128])])
    await one.run('design.sketch', { loops: SQUARE })
    await one.run('design.sketch_svg', { svg })
    expect(one.added).toEqual(['d1', 'd1'])
    const two = host([design('d1', [128, 128]), design('d2')])
    await expect(two.run('design.sketch', { loops: SQUARE })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/^design: name the design this sketch is drawn for\. Stand moved onto the bed/) })
    await expect(two.run('design.trace_image', { image: { base64: 'AA' } })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(two.run('design.sketch_svg', { svg })).rejects.toMatchObject({ code: 'invalid_input' })
    // with constraints too, refused before anything is solved
    await expect(two.run('design.sketch', { loops: SQUARE, constraints: [{ type: 'horizontal', line: { e: 0, seg: 0 } }] })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/^design: name the design/) })
    expect(two.added).toEqual([])
  })
})

describe('the change file for designs moved onto the bed', () => {
  // The design and paint tools' versions on main when this change was made (fixtures/design-tool-versions-main.json,
  // read from main's toolset). A tool this change leaves as main has it is listed here with why its answer is the
  // same; every other tool must be one minor version past main's and named in the change file at that version.
  const SAME_AS_MAIN: Record<string, string> = {
    'design.timeline': 'lists the timeline as stored: frames and transforms in plate coordinates, as on main',
    'design.roll': 'moves the rollback marker and says which steps it holds back; no design summary or coordinates',
    'design.check': 'checks a design against its plan by feature tags and sizes; no coordinates in its answer',
    'design.put_plan': 'stores a plan for a client; no design is read',
    'geom.sketch_check': 'checks loops given in a sketch plane; no design is read',
    'geom.sketch_solve': 'solves loops given in a sketch plane; no design is read',
    'geom.sketch_edit': 'edits loops given in a sketch plane; no design is read',
    'paint.preview': 'previews paint on a design\'s parts in their own frame; no design summary',
    'paint.regions': 'reads painted regions of a design\'s parts in their own frame; no design summary',
  }
  const main = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'design-tool-versions-main.json'), 'utf8')) as Record<string, string>
  const tools = new Map([...designToolset(NO_ENGINE_HOST), ...paintTools({ deps: {} } as never)].map((t) => [t.name, t.version]))
  const minorPast = (v: string) => {
    const [a, b] = v.split('.').map(Number)
    return `${a}.${b! + 1}.0`
  }

  it('names each changed tool at one minor version past main, and every tool this leaves as main is listed with why', () => {
    const text = readFileSync(join(__dirname, '..', 'changes', 'fix-mimir-design-placement.md'), 'utf8')
    const named = new Map([...text.matchAll(/`slicerx_(\w+?)` (\d+\.\d+\.\d+)/g)].map(([, n, v]) => [n!, v!] as const))
    expect(named.size).toBeGreaterThan(30)
    for (const [name, version] of tools) {
      const key = name.replace('.', '_')
      if (name in SAME_AS_MAIN) {
        expect(version, `${name} is listed as left as main`).toBe(main[name])
        expect(named.has(key), `${name} is listed as left as main`).toBe(false)
        continue
      }
      // a tool main does not have is new and needs no bump; every other one moved one minor version past main
      if (main[name] === undefined) continue
      expect(version, name).toBe(minorPast(main[name]))
      expect(named.get(key), `${name} in the change file`).toBe(version)
    }
    for (const [key, version] of named) expect(tools.get(key.replace('_', '.')), key).toBe(version)
    for (const name of Object.keys(SAME_AS_MAIN)) expect(tools.has(name), name).toBe(true)
  })
})
