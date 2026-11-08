// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.trace_image: a PNG or JPEG, by path or as base64, is traced through the engine's sketch.trace on this side and
// its loops go to the timeline through design.sketch; a dry run only reports. With the real engine, a traced
// rectangle extrudes to the volume its size says.
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { Design, DesignHost, SketchItem, SketchLoop } from '@slicerx/cad-history'
import { describe, expect, it, vi } from 'vitest'
import { cadTools } from '../src/cad'
import { designToolset, NO_CAD_FILES, NO_ENGINE_HOST } from '../src/toolset'
import { built, connect, data, GEOM_BUILD } from './helpers'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A grayscale PNG, `w` x `h`, dark where `inside` says. */
function png(w: number, h: number, inside: (x: number, y: number) => boolean): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const v of b) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type, 'latin1'), body])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(tb))
    return Buffer.concat([len, tb, c])
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(h, 4)
  head[8] = 8
  head[9] = 0
  const rows = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * (w + 1) + 1 + x] = inside(x, y) ? 0 : 255
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

// a 100 x 60 px dark rectangle in a 200 x 120 px image
const RECT = png(200, 120, (x, y) => x >= 50 && x < 150 && y >= 30 && y < 90)

const LOOPS: SketchLoop[] = [{ start: [80, 112], segments: [{ type: 'line', to: [120, 112] }, { type: 'line', to: [120, 88] }, { type: 'line', to: [80, 88] }, { type: 'line', to: [80, 112] }] }]
const reply = (over: Record<string, unknown> = {}) => ({
  loops: LOOPS,
  counts: { lines: 4, arcs: 0, splines: 0, circles: 0 },
  sizeMm: [40, 24],
  mmPerPx: 0.4,
  imagePx: [200, 120],
  workingPx: [200, 120],
  dropped: { specks: 3, holes: 0 },
  check: { ok: true, polygons: [], areaMm2: 960, loops: [{ index: 0, role: 'outer', areaMm2: 960, lengthMm: 128 }], issues: [] },
  warnings: [],
  mode: 'dark',
  threshold: 127.5,
  pxToMm: [0.4, 60, 76],
  ...over,
})

function host(answer: Record<string, unknown> = reply(), bed?: { widthMm: number; depthMm: number }, image?: (p: string) => Uint8Array) {
  const d: Design = { id: 'd1', name: 'Plate', history: { version: 1, base: [], steps: [] }, transform: I, parts: [], status: [], madeBy: {}, redo: [] }
  const sketches: SketchItem[] = []
  const engine = vi.fn(async (_op: string, _req: unknown) => answer)
  const h: DesignHost = {
    ...NO_ENGINE_HOST,
    get: () => d,
    list: () => [d],
    call: engine as DesignHost['call'],
    ...(bed ? { bed: () => bed } : {}),
    sketch: (id: string) => sketches.find((s) => s.id === id)!,
    addSketch: (s: Omit<SketchItem, 'kind' | 'id' | 'name'>) => {
      const k: SketchItem = { kind: 'sketch', id: `k${sketches.length + 1}`, name: `Sketch ${sketches.length + 1}`, ...s }
      sketches.push(k)
      return k
    },
  }
  const tools = designToolset(h, image ? { cad: { ...NO_CAD_FILES, image } } : {})
  const run = (name: string, input: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!
    return t.run(t.input.parse(input) as never, {} as never)
  }
  return { engine, run, sketches, tools }
}

describe('design.trace_image', () => {
  it('traces base64 on this side and adds the loops as a finished sketch', async () => {
    const { engine, run, sketches } = host(reply(), { widthMm: 256, depthMm: 256 })
    const out = await run('design.trace_image', { image: { base64: RECT.toString('base64') }, mode: 'dark', width_mm: 40, speck_mm2: 1 })
    expect(engine).toHaveBeenCalledWith('sketch.trace', { image: { base64: RECT.toString('base64') }, options: { mode: 'dark', speckMm2: 1, widthMm: 40, center: [128, 128] } })
    expect(sketches).toHaveLength(1)
    expect(sketches[0]!.loops).toEqual(LOOPS)
    expect(out.summary).toBe('Sketch 1 is in the timeline: 1 loop, 4 lines, 40 x 24 mm. Removed 3 specks.')
    expect(out.output).toMatchObject({ id: 'k1', name: 'Sketch 1', loops: LOOPS, counts: { lines: 4 }, sizeMm: [40, 24], imagePx: [200, 120], dropped: { specks: 3, holes: 0 }, threshold: 127.5, check: { ok: true } })
  })

  it('reads a path through the server files, and a dry run adds nothing', async () => {
    const read = vi.fn((_p: string) => new Uint8Array(RECT))
    const { engine, run, sketches } = host(reply({ previewPng: 'iVBOR' }), undefined, read)
    const out = await run('design.trace_image', { image: { path: '/art/rect.png' }, dry_run: true, preview_image: true, center: [5, 6], fit: 'lines' })
    expect(read).toHaveBeenCalledWith('/art/rect.png')
    expect(engine.mock.calls[0]![1]).toMatchObject({ options: { center: [5, 6], fit: 'lines', previewImage: true } })
    expect(sketches).toHaveLength(0)
    expect(out.summary).toBe('Traced, nothing added: 1 loop, 4 lines, 40 x 24 mm. Removed 3 specks.')
    expect(out.output).not.toHaveProperty('id')
    expect(out.images).toEqual([{ mime: 'image/png', data: 'iVBOR' }])
  })

  it("lands on the middle of the app's bed with no center, through design.sketch as a client sends it", async () => {
    const engine = vi.fn(async (_op: string, _req: unknown) => reply())
    const h: DesignHost = { ...NO_ENGINE_HOST, call: engine as DesignHost['call'], bed: () => ({ widthMm: 256, depthMm: 256 }) }
    const sent: Record<string, unknown>[] = []
    const via = {
      run: async (args: Record<string, unknown>) => (sent.push(args), { summary: 'Sketch 4', output: { id: 'k4', name: 'Sketch 4', in: 'app' } }),
      bedMiddle: async () => [175, 160] as [number, number],
    }
    const tool = cadTools({ files: NO_CAD_FILES, designs: h, sketchVia: via }).find((t) => t.name === 'design.trace_image')!
    const run = (input: Record<string, unknown>) => tool.run(tool.input.parse(input) as never, {} as never)
    const out = await run({ image: { base64: 'AA' } })
    // the app's bed, ahead of this server's
    expect(engine.mock.calls[0]![1]).toMatchObject({ options: { center: [175, 160] } })
    expect(sent).toEqual([{ loops: LOOPS }])
    expect(out.output).toMatchObject({ id: 'k4', name: 'Sketch 4', in: 'app' })
    // a link that does not answer leaves it to this server's bed; a frame or a center is kept as given
    via.bedMiddle = async () => undefined as never
    await run({ image: { base64: 'AA' } })
    expect(engine.mock.calls[1]![1]).toMatchObject({ options: { center: [128, 128] } })
    await run({ image: { base64: 'AA' }, frame: { origin: [0, 0, 5], normal: [0, 0, 1] } })
    expect(engine.mock.calls[2]![1]).toMatchObject({ options: { center: [0, 0] } })
    expect(sent[2]).toMatchObject({ frame: { origin: [0, 0, 5], normal: [0, 0, 1] } })
    await run({ image: { base64: 'AA' }, center: [3, 4] })
    expect(engine.mock.calls[3]![1]).toMatchObject({ options: { center: [3, 4] } })
  })

  it('names what is wrong, before or after the trace', async () => {
    const { tools, run } = host(reply({ loops: Array.from({ length: 257 }, () => LOOPS[0]) }))
    const input = tools.find((t) => t.name === 'design.trace_image')!.input
    expect(input.safeParse({ image: {} }).success).toBe(false)
    expect(input.safeParse({ image: { base64: 'AA' }, width_mm: 10, height_mm: 10 }).success).toBe(false)
    expect(input.safeParse({ image: { base64: 'AA' }, mode: 'color' }).success).toBe(false)
    expect(input.safeParse({ image: { base64: 'AA' }, mode: 'color', colors: ['red'] }).success).toBe(false)
    expect(input.safeParse({ image: { base64: 'AA' }, mode: 'color', colors: ['#FF0000'] }).success).toBe(true)
    expect(input.safeParse({ image: { base64: 'AA' }, smoothing_mm: 0 }).success).toBe(false)
    expect(input.safeParse({ image: { base64: 'AA' }, max_side_px: 8192 }).success).toBe(false)
    await expect(run('design.trace_image', { image: { base64: 'AA' } })).rejects.toThrow(/257 loops and a sketch takes 256\. Raise speck_mm2/)
    // a path needs a server that reads files
    await expect(run('design.trace_image', { image: { path: 'a.png' } })).rejects.toThrow(/pass the image as base64/)
    // loops over what the app link carries
    const wide = host(reply({ loops: Array.from({ length: 250 }, () => ({ start: [0.123456, 0.123456], segments: Array.from({ length: 8 }, () => ({ type: 'line', to: [10.123456, 10.123456] })) })) }))
    await expect(wide.run('design.trace_image', { image: { base64: 'AA' } })).rejects.toThrow(/the trace's loops come to \d+(\.\d)? KB, and the app link takes 63\.5 KB/)
  })
})

const geomBin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release/sx-geom')
describe.skipIf(!built(geomBin, GEOM_BUILD))('design.trace_image with the real sx-geom', () => {
  it('traces a rectangle by path and by base64 alike, and its loops extrude to the volume the size gives', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const file = join(h.dir, 'rect.png')
    writeFileSync(file, RECT)
    const byPath = await h.call('slicerx_design_trace_image', { image: { path: file }, width_mm: 40, center: [0, 0], dry_run: true })
    expect(byPath.isError, JSON.stringify(byPath.content)).toBeFalsy()
    const traced = data<{ output: { loops: SketchLoop[]; counts: { lines: number }; sizeMm: [number, number]; check: { ok: boolean } } }>(byPath).output
    expect(traced.counts.lines).toBe(4)
    expect(traced.sizeMm).toEqual([40, 24])
    expect(traced.check.ok).toBe(true)
    const byData = await h.call('slicerx_design_trace_image', { image: { base64: RECT.toString('base64') }, width_mm: 40, center: [0, 0], dry_run: true })
    expect(data<{ output: { loops: SketchLoop[] } }>(byData).output.loops).toEqual(traced.loops)
    const solid = await h.call('slicerx_geom_extrude', { shape: { type: 'sketch', loops: traced.loops }, distance_mm: 2 })
    expect(solid.isError, JSON.stringify(solid.content)).toBeFalsy()
    expect(data<{ output: { volumeMm3: number } }>(solid).output.volumeMm3).toBeCloseTo(40 * 24 * 2, 3)
    const bad = await h.call('slicerx_design_trace_image', { image: { base64: Buffer.from('not an image').toString('base64') }, dry_run: true })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toMatch(/image/)
  })
})
