// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design engine served for the whole server (geom-served.ts), against a stand-in sx-geom (served-engine.ts):
// one process for every call, bodies held there by number and named by that process, a process that stops never sent
// a number from before it, today's process per call for an sx-geom with no serve mode, and two tool calls at once on
// one served engine, where no body is freed while another replay still uses it.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'
import { paintCodes, servedGeomEngine } from '../src/geom-served'
import { connect, data, text } from './helpers'
import { standInBin } from './served-engine'

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A stand-in sx-geom and the log of what reached it. */
function setUp() {
  const dir = mkdtempSync(join(tmpdir(), 'sx-geom-served-'))
  dirs.push(dir)
  const log = join(dir, 'calls.jsonl')
  vi.stubEnv('SX_STANDIN_LOG', log)
  const read = (): { pid: number; op?: string; body?: unknown; asText?: boolean; freed?: number }[] => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return { bin: standInBin(dir), read }
}

const PER_PROCESS = 2 ** 32

describe.skipIf(process.platform === 'win32')('the served design engine', () => {
  it('runs every call in one process and holds bodies there, named by that process', async () => {
    const { bin, read } = setUp()
    const engine = servedGeomEngine(bin, { perCall: geomEngine(bin) })
    expect(await engine.keepsBodies()).toBe(true)
    const made = (await engine('brep.extrude', { withKeys: true, keySalt: 10 })) as { body: number; bodyKeys: number[] }
    expect(made.body).toBe(PER_PROCESS + 1)
    expect(made.bodyKeys).toEqual([11, 12, 13])
    const mesh = (await engine('brep.tessellate', { body: made.body })) as { faceIds: number[] }
    expect(mesh.faceIds).toEqual([0, 1, 2])
    // the engine saw its own number, from one process
    const calls = read().filter((c) => c.op)
    expect(calls.map((c) => [c.op, c.body])).toEqual([['brep.extrude', null], ['brep.tessellate', 1]])
    expect(new Set(calls.map((c) => c.pid)).size).toBe(1)
  }, 30_000)

  it('never sends a body of a process that stopped to the next one, and starts the next one for the next call', async () => {
    const { bin, read } = setUp()
    const engine = servedGeomEngine(bin, { perCall: geomEngine(bin) })
    const made = (await engine('brep.extrude', { withKeys: true })) as { body: number }
    await expect(engine('test.exit', {})).rejects.toThrow(/ended before it answered/)
    await expect(engine('brep.tessellate', { body: made.body })).rejects.toThrow(/named a body of an engine process that stopped/)
    expect(await engine('brep.free', { body: made.body })).toEqual({ freed: false })
    // the next call runs in a new process, whose bodies are named by it
    const next = (await engine('brep.extrude', { withKeys: true })) as { body: number }
    expect(next.body).toBe(2 * PER_PROCESS + 1)
    const calls = read().filter((c) => c.op)
    expect(calls.filter((c) => c.op === 'brep.tessellate' || c.op === 'brep.free')).toEqual([])
    expect(new Set(calls.map((c) => c.pid)).size).toBe(2)
  }, 30_000)

  it('runs an sx-geom with no serve mode once per call, as before, holding no bodies', async () => {
    const { bin, read } = setUp()
    vi.stubEnv('SX_STANDIN_NO_SERVE', '1')
    const engine = servedGeomEngine(bin, { perCall: geomEngine(bin), helloMs: 500 })
    expect(await engine.keepsBodies()).toBe(false)
    expect(await engine('brep.count', {})).toEqual({ bodies: 0 })
    expect(await engine('brep.extrude', { save: true })).toEqual({ bodySmb: 'faces:3' })
    const calls = read().filter((c) => c.op)
    // the one look at whether it serves (it takes `serve` as an operation and refuses it), then a process per call
    expect(calls.map((c) => c.op)).toEqual(['serve', 'brep.count', 'brep.extrude'])
    expect(new Set(calls.map((c) => c.pid)).size).toBe(3)
  }, 30_000)

  it('starts a binary served with the arguments it is given, as the desktop app takes --sx-geom-engine', async () => {
    const { bin, read } = setUp()
    const engine = servedGeomEngine(bin, { args: ['--sx-geom-engine'], perCall: geomEngine(bin) })
    expect(await engine.keepsBodies()).toBe(true)
    const made = (await engine('brep.extrude', { withKeys: true })) as { body: number }
    expect(made.body).toBe(PER_PROCESS + 1)
    expect(new Set(read().filter((c) => c.op).map((c) => c.pid)).size).toBe(1)
  })

  it('names a lofted body by the process that made it, as it names a kernel body, so later calls reach it', async () => {
    const { bin, read } = setUp()
    vi.stubEnv('SX_BREP_DEV', '1')
    const h = await connect({ sxGeomBin: bin })
    const created = await h.call('slicerx_design_new', { name: 'Lofted', exact: true })
    const design = data<{ output: { design: string } }>(created).output.design
    const section = (x: number, half: number) => ({ frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: [[-half, 0], [half, 0], [half, 12], [-half, 12]] }] })
    const lofted = await h.call('slicerx_geom_loft', { design, profiles: [section(0, 4), section(40, 12)], name: 'Body' })
    expect(lofted.isError, text(lofted)).toBeFalsy()
    const calls = read().filter((c) => c.op)
    // the loft went to the engine as an exact one, and its body was then read there by number, in the same process
    expect(calls.map((c) => c.op)).toEqual(expect.arrayContaining(['sketch.loft', 'brep.tessellate']))
    expect(calls.find((c) => c.op === 'brep.tessellate')?.body).toBe(1)
    expect(new Set(calls.map((c) => c.pid)).size).toBe(1)
  }, 30_000)

  it('takes two tool calls at once on one served engine, and frees no body another replay still uses', async () => {
    const { bin, read } = setUp()
    vi.stubEnv('SX_BREP_DEV', '1')
    const h = await connect({ sxGeomBin: bin })
    const ids: string[] = []
    for (const name of ['Left', 'Right']) {
      const created = await h.call('slicerx_design_new', { name, exact: true })
      expect(created.isError, text(created)).toBeFalsy()
      const design = data<{ output: { design: string } }>(created).output.design
      ids.push(design)
      const made = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 5 })
      expect(made.isError, text(made)).toBeFalsy()
    }
    const cut = (design: string, x: number) => h.call('slicerx_geom_extrude', { design, shape: { type: 'circle', diameterMm: 3 }, frame: { origin: [x, 5, 5], normal: [0, 0, 1] }, distance_mm: 5, operation: 'cut' })
    const both = await Promise.all(ids.flatMap((d) => [cut(d, 5), cut(d, 10)]))
    for (const r of both) expect(r.isError, text(r)).toBeFalsy()
    const lines = read()
    // one process, bodies by number only: no solid text went to the engine
    expect(new Set(lines.map((l) => l.pid)).size).toBe(1)
    expect(lines.filter((l) => l.op && l.asText)).toEqual([])
    // no call named a body after it was freed, and none was freed twice
    const freed = new Set<number>()
    for (const l of lines) {
      if (l.freed !== undefined) {
        expect(freed.has(l.freed)).toBe(false)
        freed.add(l.freed)
      } else if (typeof l.body === 'number') expect(freed.has(l.body)).toBe(false)
    }
  }, 60_000)
})

describe('a project read on a served engine', () => {
  it('reads each part\'s paint buffer as the per-call run prints it, layer by layer as [triangle, code] pairs', () => {
    // the engine's paint buffer (packages/geom/src/format/json.rs, paint): per layer a count, then triangle, length, code
    const bytes: number[] = []
    const u32 = (n: number) => bytes.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff)
    const entry = (t: number, code: string) => (u32(t), u32(code.length), bytes.push(...new TextEncoder().encode(code)))
    u32(2), entry(2, '7FC'), entry(3, '7FC')
    u32(1), entry(0, '4')
    u32(0), u32(0)
    const answer = { objects: [{ id: 1, parts: [{ name: 'Box', paint: { rawBytes: 0 } }, { name: 'Box 2', paint: null }] }] }
    expect(paintCodes(answer, [new Uint8Array(bytes)])).toEqual({
      objects: [{ id: 1, parts: [{ name: 'Box', paint: { color: [[2, '7FC'], [3, '7FC']], seam: [[0, '4']], support: [], fuzzy: [] } }, { name: 'Box 2', paint: null }] }],
    })
    expect(() => paintCodes({ paint: { rawBytes: 1 } }, [])).toThrow('The geometry engine named a buffer it did not send: 1')
  })
})
