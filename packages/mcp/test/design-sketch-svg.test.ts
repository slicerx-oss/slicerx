// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.sketch_svg: SVG text becomes a finished sketch in the host's timeline through the engine's sketch.svg, and
// the reply carries the loops as stored, so a client reads back what it made and extrudes it by id.
import type { Design, DesignHost, SketchItem, SketchLoop, StepParams } from '@slicerx/cad-history'
import { describe, expect, it, vi } from 'vitest'
import { designToolset, NO_ENGINE_HOST } from '../src/toolset'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const SVG = '<svg viewBox="0 0 40 40" width="40mm"><path d="M0 0H40V40H0Z M20 12A8 8 0 1 0 20 28A8 8 0 1 0 20 12Z"/></svg>'
const LOOPS: SketchLoop[] = [
  { start: [80, 120], segments: [{ type: 'line', to: [120, 120] }, { type: 'line', to: [120, 80] }, { type: 'line', to: [80, 80] }, { type: 'line', to: [80, 120] }] },
  { type: 'circle', center: [100, 100], diameterMm: 16 },
]
const check = (issues: { loop: number; kind: string; message: string }[] = []) => ({
  ok: issues.length === 0,
  polygons: [{ outer: [[0, 0]], holes: [] }],
  areaMm2: 1398.94,
  loops: [
    { index: 0, role: 'outer', areaMm2: 1600, lengthMm: 160 },
    { index: 1, role: 'hole', areaMm2: 201.06, lengthMm: 50.27 },
  ],
  issues,
})
const reply = (over: Record<string, unknown> = {}) => ({ loops: LOOPS, counts: { lines: 4, arcs: 0, splines: 0, circles: 1 }, sizeMm: [40, 40], mmPerUnit: 1, check: check(), warnings: [], ...over })

function host(answer: Record<string, unknown> = reply(), withSketches = true, bed?: { widthMm: number; depthMm: number }) {
  const d: Design = { id: 'd1', name: 'Plate', history: { version: 1, base: [], steps: [] }, transform: I, parts: [], status: [], madeBy: {}, redo: [] }
  const sketches: SketchItem[] = []
  const engine = vi.fn(async (_op: string, _req: unknown) => answer)
  const add = vi.fn(async (_d: Design, part: number, params: StepParams, _l?: string, opts?: { sketch?: string }) => {
    const step = { id: `s${d.history.steps.length}`, part, transform: I, params, ...(opts?.sketch ? { sketch: opts.sketch } : {}) }
    d.history = { ...d.history, steps: [...d.history.steps, step] }
    return step
  })
  const h: DesignHost = {
    ...NO_ENGINE_HOST,
    get: () => d,
    list: () => [d],
    add,
    call: engine as DesignHost['call'],
    ...(bed ? { bed: () => bed } : {}),
    ...(withSketches
      ? {
          sketch: (id: string) => {
            const k = sketches.find((s) => s.id === id)
            if (!k) throw new Error(`no sketch ${id}`)
            return k
          },
          addSketch: (s: Omit<SketchItem, 'kind' | 'id' | 'name'>) => {
            const k: SketchItem = { kind: 'sketch', id: `k${sketches.length + 1}`, name: `Sketch ${sketches.length + 1}`, ...s }
            sketches.push(k)
            return k
          },
        }
      : {}),
  }
  const tools = designToolset(h)
  const run = (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input as never, {} as never)
  return { engine, add, run, sketches }
}

describe('design.sketch_svg', () => {
  it('sends the sizing to sketch.svg and puts the loops in the timeline', async () => {
    const { engine, run, sketches } = host()
    const out = await run('design.sketch_svg', { svg: SVG, fit_width_mm: 40, center: [100, 100], frame: { origin: [0, 0, 5], normal: [0, 0, 1] } })
    expect(engine).toHaveBeenCalledWith('sketch.svg', { svg: SVG, options: { fitWidthMm: 40, center: [100, 100] } })
    expect(sketches).toHaveLength(1)
    expect(sketches[0]!.loops).toEqual(LOOPS)
    expect(sketches[0]!.frame?.origin).toEqual([0, 0, 5])
    expect(out.summary).toBe('Sketch 1 is in the timeline: 2 loops (1 hole), 4 lines, 1 circle, 40 x 40 mm')
    expect(out.output).toMatchObject({ id: 'k1', name: 'Sketch 1', loops: LOOPS, counts: { lines: 4, circles: 1 }, sizeMm: [40, 40], check: { ok: true }, warnings: [] })
    // the check's flattened polygons stay out of the reply
    expect((out.output as { check: Record<string, unknown> }).check).not.toHaveProperty('polygons')
  })

  it('lets a client read back what it made and extrude it by id, the step carrying the same loops', async () => {
    const { add, run } = host()
    const made = (await run('design.sketch_svg', { svg: SVG, scale: 0.5 })).output as { id: string; loops: SketchLoop[] }
    await run('design.sketch_svg', { svg: SVG, fit_height_mm: 10, tolerance_mm: 0.05 })
    await run('geom.extrude', { design: 'd1', sketch: made.id, distance_mm: 3 })
    const p = add.mock.calls[0]![2] as Extract<StepParams, { op: 'shape.extrude' }>
    expect(p.shape).toEqual({ type: 'sketch', loops: made.loops })
    expect(add.mock.calls[0]![4]).toEqual({ sketch: made.id })
  })

  it('says what to fix and what was left out, and refuses curves too dense to draw', async () => {
    const crossed = host(reply({ check: check([{ loop: 1, kind: 'loopsCross', message: 'Loops 1 and 2 cross.' }]), warnings: ['<text> is not supported and was ignored'] }))
    const out = await crossed.run('design.sketch_svg', { svg: SVG })
    expect(out.summary).toBe('Sketch 1 is in the timeline: 2 loops (1 hole), 4 lines, 1 circle, 40 x 40 mm. 1 problem to fix before it makes a solid: Loops 1 and 2 cross. <text> is not supported and was ignored.')
    const dense = host(reply({ check: check([{ loop: 0, kind: 'tooDense', message: 'Loop 1 has more than 65536 points once its curves are drawn.' }]) }))
    await expect(dense.run('design.sketch_svg', { svg: SVG })).rejects.toThrow(/svg: Loop 1 has more than 65536 points.*Raise tolerance_mm/)
    expect(dense.sketches).toHaveLength(0)
  })

  it('keeps a spline the engine cannot draw out of the timeline, as design.sketch does', async () => {
    const wavy: SketchLoop[] = [{ start: [0, 0], segments: [{ type: 'spline', to: [10, 0], points: [[5, 0], [5, 0]] }, { type: 'line', to: [0, 0] }] }, LOOPS[1]!]
    const twice = { loop: 0, kind: 'zeroLength', message: 'Loop 1 has the same point twice in a row.' }
    const bad = host(reply({ loops: wavy, check: check([twice]) }))
    await expect(bad.run('design.sketch_svg', { svg: SVG })).rejects.toThrow(/svg: Loop 1 has the same point twice in a row\. Raise tolerance_mm/)
    expect(bad.sketches).toHaveLength(0)
    // the same issue on a loop of lines is the client's to fix, so the sketch is kept and the problem named
    const lines = host(reply({ check: check([twice]) }))
    const out = await lines.run('design.sketch_svg', { svg: SVG })
    expect(lines.sketches).toHaveLength(1)
    expect(out.summary).toMatch(/1 problem to fix before it makes a solid: Loop 1 has the same point twice in a row\./)
  })

  it("puts the artwork's middle at the middle of the plane when no center is given, as the panel does", async () => {
    const onBed = host(reply(), true, { widthMm: 256, depthMm: 220 })
    await onBed.run('design.sketch_svg', { svg: SVG, fit_width_mm: 40 })
    expect(onBed.engine).toHaveBeenLastCalledWith('sketch.svg', { svg: SVG, options: { fitWidthMm: 40, center: [128, 110] } })
    // on a plane or face the middle is the frame's origin
    await onBed.run('design.sketch_svg', { svg: SVG, frame: { origin: [0, 0, 5], normal: [0, 0, 1] } })
    expect(onBed.engine).toHaveBeenLastCalledWith('sketch.svg', { svg: SVG, options: { center: [0, 0] } })
    // a center given wins
    await onBed.run('design.sketch_svg', { svg: SVG, center: [10, 20] })
    expect(onBed.engine).toHaveBeenLastCalledWith('sketch.svg', { svg: SVG, options: { center: [10, 20] } })
    // a host that knows no bed keeps the origin
    const bare = host()
    await bare.run('design.sketch_svg', { svg: SVG })
    expect(bare.engine).toHaveBeenLastCalledWith('sketch.svg', { svg: SVG, options: { center: [0, 0] } })
  })

  it('takes only as many bytes as the app link carries, counting non-Latin text and every field as sent', () => {
    const tool = designToolset(NO_ENGINE_HOST).find((t) => t.name === 'design.sketch_svg')!
    const pad = (n: number, c: string) => `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H10V10Z"/><desc>${c.repeat(n)}</desc></svg>`
    const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
    const refused = (r: ReturnType<typeof tool.input.safeParse>) => (r.success ? [] : r.error.issues.map((x) => x.message))
    // 25 000 characters of three bytes each: 25 KB of text, 73 KB sent
    const kanji = tool.input.safeParse({ svg: pad(25_000, '漢') })
    expect(refused(kanji)).toEqual([expect.stringMatching(/^This SVG comes to 73\.\d KB once sent to the app, and the app link takes 63\.5 KB\. Simplify it in a vector editor/)])
    // the limit is 64 KB less 512 bytes, of the whole arguments object
    const limit = 64 * 1024 - 512
    const fill = (extra: Record<string, unknown>, target: number) => {
      const base = { svg: pad(0, ''), ...extra }
      return { ...extra, svg: pad(target - bytes(base), 'a') }
    }
    const at = fill({}, limit)
    expect(bytes(at)).toBe(limit)
    expect(tool.input.safeParse(at).success).toBe(true)
    const over = fill({}, limit + 1)
    expect(refused(tool.input.safeParse(over))).toHaveLength(1)
    // the other fields count too
    const framed = fill({ frame: { origin: [0, 0, 5], normal: [0, 0, 1] }, center: [10.5, 20.25] }, limit + 1)
    expect(tool.input.safeParse({ ...framed }).success).toBe(false)
    expect(tool.input.safeParse({ ...framed, svg: framed.svg.slice(1) }).success).toBe(true)
    // quotes are escaped on the way
    expect(tool.input.safeParse({ svg: pad(40_000, '"') }).success).toBe(false)
  })

  it('needs the app timeline, and checks its input', async () => {
    const { run } = host(reply(), false)
    await expect(run('design.sketch_svg', { svg: SVG })).rejects.toThrow(/design timeline of the project open in the app/)
    const tools = designToolset(NO_ENGINE_HOST)
    const tool = tools.find((t) => t.name === 'design.sketch_svg')!
    expect(tool.input.safeParse({ svg: '' }).success).toBe(false)
    expect(tool.input.safeParse({ svg: SVG, fit_width_mm: 0 }).success).toBe(false)
    expect(tool.input.safeParse({ svg: SVG, tolerance_mm: 2 }).success).toBe(false)
    expect(tool.input.safeParse({ svg: SVG, tolerance_mm: 0.0005 }).success).toBe(false)
    expect(tool.input.safeParse({ svg: SVG, tolerance_mm: 0.001 }).success).toBe(true)
    expect(tool.input.safeParse({ svg: SVG, center: [1] }).success).toBe(false)
  })
})
