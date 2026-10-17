// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_parts_lookup the way a client uses it: listed as a read-only tool, called by name over MCP, and run with
// `slicerx-mcp call` as its own process. The answer carries every size with its unit and source link, and a part the
// table lacks comes back as an error that names the nearest entries. The table is the fixture the pilot tests build
// (packages/pilot/test/fixtures), passed as the server's --parts-table.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'

const PKG = resolve(__dirname, '..')
const TABLE = resolve(__dirname, '../../pilot/test/fixtures/standard-parts.table.json')
const NSK = 'https://www.nsk.com/content/dam/nsk/am/en_us/documents/bearings-americas/Bearing-and-Linear-Replacement-Guide.pdf'

interface Size {
  key: string
  value: unknown
  unit: string | null
  source_url: string | null
  status?: string
}
interface Found {
  ok: boolean
  summary: string
  output: { found: true; query: string; parts: { category: string; id: string; name: string; sizes: Size[] }[] }
}
interface NotFound {
  ok: false
  summary: string
  output: { found: false; nearest: { category: string; id: string; name: string }[]; hint: string }
}

describe('slicerx_parts_lookup over MCP', () => {
  it('is listed as a read-only tool that takes a name and an optional category', async () => {
    const h = await connect({ partsTable: TABLE })
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_parts_lookup')
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    const schema = tool?.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['category', 'name'])
    expect(schema.required).toEqual(['name'])
  })

  it('answers a named part with every size, its unit and its source link', async () => {
    const h = await connect({ partsTable: TABLE })
    const r = await h.call('slicerx_parts_lookup', { name: '608ZZ' })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<Found>(r)
    expect(out.summary).toBe('608 bearing: bore 8 mm, outside diameter 22 mm, width 7 mm')
    expect(out.output.parts.map((p) => `${p.category}/${p.id}`)).toEqual(['bearings/608'])
    const sizes = out.output.parts[0]!.sizes
    expect(sizes.filter((s) => s.value !== null).map((s) => [s.key, s.value, s.unit, s.source_url])).toEqual([
      ['bore', 8, 'mm', NSK],
      ['outside_diameter', 22, 'mm', NSK],
      ['width', 7, 'mm', NSK],
    ])
  })

  it('narrows to a category, and reads the same answer back on a second call', async () => {
    const h = await connect({ partsTable: TABLE })
    const first = data<Found>(await h.call('slicerx_parts_lookup', { name: 'M3', category: 'heat-set-inserts' }))
    expect(first.output.parts.map((p) => p.id)).toEqual(['SPIROL-29-30-M3x0.5'])
    const again = data<Found>(await h.call('slicerx_parts_lookup', { name: 'M3 heat set insert' }))
    expect(again.output.parts).toEqual(first.output.parts)
    const screw = data<Found>(await h.call('slicerx_parts_lookup', { name: 'M3 screw clearance hole' }))
    expect(screw.output.parts.map((p) => p.id)).toEqual(['M3'])
  })

  it('says a part is not in the table, with the nearest entries, as an error the client can read', async () => {
    const h = await connect({ partsTable: TABLE })
    const r = await h.call('slicerx_parts_lookup', { name: 'Raspberry Pi' })
    expect(r.isError).toBe(true)
    const out = data<NotFound>(r)
    expect(out.summary).toMatch(/^"Raspberry Pi" is not in the standard parts table; nearest: /)
    expect(out.output.nearest.map((n) => n.id)).toEqual(expect.arrayContaining(['pi4', 'pi5']))
    expect(out.output.hint).toMatch(/ask which one/)
    expect(text(await h.call('slicerx_parts_lookup', {}))).toContain('Invalid arguments for tool slicerx_parts_lookup')
  })

  it('reads the bundled table when none is given', async () => {
    const h = await connect()
    const r = await h.call('slicerx_parts_lookup', { name: 'iPhone 15' })
    expect(r.isError, text(r)).toBeFalsy()
    const part = data<Found>(r).output.parts[0]!
    expect(part).toMatchObject({ category: 'phones', id: 'iphone-15' })
    for (const s of part.sizes) expect(s, s.key).toMatchObject({ unit: 'mm', source_url: expect.stringMatching(/^https:\/\/support\.apple\.com\//) })
    expect((await h.call('slicerx_parts_lookup', { name: 'no such part' })).isError).toBe(true)
  })
})

/** One line of `call`: the tool, whether it answered, its text, and its structured reply ({ ok, summary, output }). */
interface Line {
  tool: string
  ok: boolean
  text: string
  output: unknown
}

/** One `slicerx-mcp call ...` run as its own process, with a home and output folder of its own. */
function call(parent: string, words: string[]): Promise<{ code: number; lines: Line[]; stderr: string }> {
  const dir = mkdtempSync(join(parent, 'call-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('SLICERX_')) env[k] = v
  env['HOME'] = dir
  env['USERPROFILE'] = dir
  const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--printers', 'off', '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), '--parts-table', TABLE, 'call', ...words]
  return new Promise((done) => {
    execFile(process.execPath, args, { cwd: PKG, env, timeout: 50_000 }, (err, stdout, stderr) => {
      const lines = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line)
      done({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, lines, stderr })
    })
  })
}

describe.concurrent('slicerx-mcp call parts_lookup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-parts-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('prints each part with its sizes and sources, one JSON line per call, and exits 0', async () => {
    const r = await call(dir, ['parts_lookup', '{"name":"NEMA 17"}', 'slicerx_parts_lookup', '{"name":"Raspberry Pi 4"}'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.lines.map((l) => [l.tool, l.ok])).toEqual([
      ['slicerx_parts_lookup', true],
      ['slicerx_parts_lookup', true],
    ])
    const motor = (r.lines[0]!.output as Found).output
    expect(motor.parts.map((p) => p.id)).toEqual(['SY42STH38-1684A'])
    for (const s of motor.parts[0]!.sizes) if (s.value !== null) expect(s.source_url, s.key).toMatch(/^https:\/\/www\.pololu\.com\//)
    const pi = (r.lines[1]!.output as Found).output
    expect(pi.parts[0]!.sizes.find((s) => s.key === 'mount_hole_diameter')).toMatchObject({ value: 2.7, unit: 'mm' })
  }, 60_000)

  it('exits 1 on a part the table lacks, and says so in plain words', async () => {
    const r = await call(dir, ['parts_lookup', '{"name":"Galaxy S24"}'])
    expect(r.code).toBe(1)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatchObject({ tool: 'slicerx_parts_lookup', ok: false })
    expect((JSON.parse(r.lines[0]!.text) as { summary: string }).summary).toBe('"Galaxy S24" is not in the standard parts table')
    expect((r.lines[0]!.output as NotFound).output).toMatchObject({ found: false, nearest: [] })
  }, 60_000)
})
