// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The standard parts table and parts.lookup: the converter turns checked category files into the table, the loader
// refuses a table with a value and no source, the matcher finds a part by its id, name or alias (and lists the nearest
// when nothing matches), and the tool answers with every size's unit and source link. Fixtures are a few records of
// the category files, in test/fixtures/standard-parts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalHost, LlmTransport, PrinterHost } from '@slicerx/contracts'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { buildPartsTable } from '../scripts/build-parts'
import { DEFAULT_CONFIG } from '../src/config'
import { matchParts, words } from '../src/parts/match'
import { bundledPartsTable, loadPartsTable, type PartsTable } from '../src/parts/table'
import { PARTS_LINE, systemPrompt } from '../src/prompt'
import { createScriptedClient } from '../src/provider/scripted'
import { CAD_TOOLS, createPilot } from '../src/runtime'
import { builtinTools } from '../src/tools/index'
import { lookupParts, partsTool, sizeText } from '../src/tools/parts'
import { lookupTool } from '../src/tools/ask'
import { defineTool, type PilotTool, type ToolContext } from '../src/tool'
import { z } from 'zod'

const FIXTURES = join(__dirname, 'fixtures', 'standard-parts')
const TABLE_FILE = join(__dirname, 'fixtures', 'standard-parts.table.json')
const table = (): PartsTable => loadPartsTable(JSON.parse(readFileSync(TABLE_FILE, 'utf8')))
const NSK = 'https://www.nsk.com/content/dam/nsk/am/en_us/documents/bearings-americas/Bearing-and-Linear-Replacement-Guide.pdf'

const found = (q: string, category?: string): string[] => {
  const r = matchParts(table(), q, category)
  return r.found ? r.matches.map((m) => `${m.record.category}/${m.record.id}`) : []
}

describe('the converter', () => {
  it('builds the committed fixture table from the fixture folder, byte for byte', () => {
    expect(`${JSON.stringify(buildPartsTable(FIXTURES), null, 2)}\n`).toBe(readFileSync(TABLE_FILE, 'utf8'))
  })

  it('keeps every value with its unit and source, and a missing value as null with its reason', () => {
    const t = buildPartsTable(FIXTURES)
    expect(t.categories.map((c) => c.id)).toEqual(['arduino', 'bearings', 'cells', 'heat-set-inserts', 'motors', 'phones', 'raspberry-pi', 'screw-holes', 'spools'])
    const b608 = t.records.find((r) => r.id === '608')!
    expect(b608).toMatchObject({ category: 'bearings', name: '608 bearing', info: { manufacturer: 'NSK', locator: 'PDF page 29' } })
    expect(b608.aliases).toEqual(expect.arrayContaining(['608ZZ', '608-2RS']))
    expect(b608.sizes.filter((s) => s.value !== null).map((s) => [s.key, s.value, s.unit, s.source_url])).toEqual([
      ['bore', 8, 'mm', NSK],
      ['outside_diameter', 22, 'mm', NSK],
      ['width', 7, 'mm', NSK],
    ])
    for (const r of t.records) for (const s of r.sizes) if (s.value !== null) expect(s.source_url, `${r.id} ${s.key}`).toMatch(/^https:\/\//)
    // a re-read value keeps where in the source it is and when it was read
    const iphone = t.records.find((r) => r.id === 'iphone-15')!
    expect(iphone).toMatchObject({ category: 'phones', name: 'Apple iPhone 15' })
    expect(iphone.sizes.map((s) => s.key)).toEqual(['height', 'width', 'depth'])
    for (const s of iphone.sizes) expect(s, s.key).toMatchObject({ unit: 'mm', locator: expect.any(String), verified_utc: expect.any(String) })
  })

  it('keys named list entries by name and keeps their text as information', () => {
    const pi4 = buildPartsTable(FIXTURES).records.find((r) => r.id === 'pi4')!
    expect(pi4.name).toBe('Raspberry Pi 4 Model B')
    expect(pi4.aliases).toEqual(expect.arrayContaining(['Raspberry Pi 4', 'Pi 4', 'RPi 4']))
    expect(pi4.sizes.find((s) => s.key === 'ports.USB-C power.centerline')).toMatchObject({ value: 11.2, unit: 'mm', status: 'derived' })
    expect(pi4.info['ports.USB-C power.edge']).toBe('bottom')
    expect(pi4.sizes.find((s) => s.key === 'mount_hole_centers')?.value).toEqual([[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]])
  })

  it('reads a category it has no rules for by its title and own aliases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parts-build-'))
    try {
      // a made-up category, to check the default path; example.com is the reserved example domain
      const missing = [{ field: 'depth', value: null, status: 'unsourced', reason: 'Not on the drawing.', source_url: 'https://example.com/w1.pdf' }]
      writeFileSync(join(dir, 'widgets.json'), JSON.stringify({ schema_version: '1', checked_utc: '2026-10-15T00:00:00Z', scope: 'Test only.', records: [{ id: 'w1', title: 'Widget One Rev 2', aliases: ['W-1'], body: { width: { value: 10, unit: 'mm', source_url: 'https://example.com/w1.pdf' } }, missing }] }))
      writeFileSync(join(dir, 'validation.json'), JSON.stringify({ result: 'PASS' }))
      const t = buildPartsTable(dir)
      expect(t.categories).toEqual([{ id: 'widgets', words: ['widget'], scope: 'Test only.', checked_utc: '2026-10-15T00:00:00Z' }])
      expect(t.records[0]).toMatchObject({ id: 'w1', name: 'Widget One Rev 2', aliases: ['Widget One', 'W-1'] })
      expect(t.records[0]!.sizes[0]).toEqual({ key: 'body.width', value: 10, unit: 'mm', source_url: 'https://example.com/w1.pdf' })
      // a value the source does not give stays null with its reason, keyed by its field; never filled in
      expect(t.records[0]!.sizes[1]).toEqual({ key: 'depth', value: null, unit: null, source_url: 'https://example.com/w1.pdf', status: 'unsourced', reason: 'Not on the drawing.' })
      expect(lookupParts(t, 'Widget One').display?.[0]).toMatchObject({ rows: [['body, width', '10 mm', 'example.com'], ['depth', { text: 'not published', tone: 'dim' }, 'example.com']] })
      expect(matchParts(t, 'a widget one holder')).toMatchObject({ found: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a folder with a value that has no source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parts-build-'))
    try {
      writeFileSync(join(dir, 'bearings.json'), JSON.stringify({ scope: '', records: [{ id: '608', bore: { value: 8, unit: 'mm' } }] }))
      expect(() => buildPartsTable(dir)).toThrow(/608 bore has a value without its source/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the loader', () => {
  const base = (): PartsTable => JSON.parse(readFileSync(TABLE_FILE, 'utf8')) as PartsTable

  it('loads the fixture table and the bundled one', async () => {
    expect(table().records).toHaveLength(13)
    const bundled = await bundledPartsTable()
    expect(bundled.schema_version).toBe(1)
    expect(bundled.license).toMatch(/source_url/)
  })

  it('refuses a table that breaks the schema or its rules', () => {
    expect(() => loadPartsTable({ ...base(), schema_version: 2 })).toThrow()
    const dup = base()
    dup.records.push(dup.records[0]!)
    expect(() => loadPartsTable(dup)).toThrow(/twice/)
    const orphan = base()
    orphan.records[0]!.category = 'nowhere'
    expect(() => loadPartsTable(orphan)).toThrow(/unknown category/)
    const filled = base()
    filled.records[0]!.sizes[0]!.status = 'unsourced'
    expect(() => loadPartsTable(filled)).toThrow(/unsourced but has a value/)
    const bare = base()
    bare.records[0]!.sizes[0]!.source_url = null
    expect(() => loadPartsTable(bare)).toThrow(/without its source/)
  })
})

describe('the matcher', () => {
  it('reads names word by word, splitting letters from digits', () => {
    expect(words('NEMA17')).toEqual(['nema', '17'])
    expect(words('608ZZ')).toEqual(['608', 'zz'])
    expect(words('M2.5x0.45 insert.')).toEqual(['m2.5x0.45', 'insert'])
    expect(words('Polymaker 1kg')).toEqual(['polymaker', '1', 'kg'])
  })

  it('finds a part by its id', () => {
    expect(found('608')).toEqual(['bearings/608'])
    expect(found('M3')).toEqual(['screw-holes/M3'])
    expect(found('pi4')).toEqual(['raspberry-pi/pi4'])
  })

  it('finds a part by an alias or its name in a longer request', () => {
    expect(found('608ZZ')).toEqual(['bearings/608'])
    expect(found('608-2RS bearing')).toEqual(['bearings/608'])
    expect(found('a holder for two 608 bearings')).toEqual(['bearings/608'])
    expect(found('NEMA17')).toEqual(['motors/SY42STH38-1684A'])
    expect(found('NEMA 17 stepper mount')).toEqual(['motors/SY42STH38-1684A'])
    expect(found('M3 screw clearance hole')).toEqual(['screw-holes/M3'])
    expect(found('M3x10 screw')).toEqual(['screw-holes/M3'])
    expect(found('Raspberry Pi 4 case')).toEqual(['raspberry-pi/pi4'])
    expect(found('Polymaker 1kg spool')).toEqual(['spools/polymaker-1kg-cardboard'])
    expect(found('iPhone 15')).toEqual(['phones/iphone-15'])
    expect(found('case for an iPhone 15 Pro')).toEqual(['phones/iphone-15-pro'])
    expect(found('AA battery holder')).toEqual(['cells/energizer-e91-aa'])
    expect(found('18650 cell holder')).toEqual(['cells/molicel-inr18650-m35a'])
    expect(found('Arduino Uno')).toEqual(['arduino/arduino-uno-r3'])
  })

  it('takes the most specific name: an M3 insert is not the M3 screw hole', () => {
    expect(found('M3 heat set insert')).toEqual(['heat-set-inserts/SPIROL-29-30-M3x0.5'])
    expect(found('M3', 'heat-set-inserts')).toEqual(['heat-set-inserts/SPIROL-29-30-M3x0.5'])
    expect(found('M3', 'insert')).toEqual(['heat-set-inserts/SPIROL-29-30-M3x0.5'])
  })

  it('needs a bearing to be named before a bare number counts as one', () => {
    expect(found('6000')).toEqual(['bearings/6000'])
    expect(found('6000', 'bearings')).toEqual(['bearings/6000'])
    expect(found('6000 mAh battery box')).toEqual([])
  })

  it('lists the nearest entries when nothing matches', () => {
    const family = matchParts(table(), 'Raspberry Pi')
    expect(family).toMatchObject({ found: false, categories: ['raspberry-pi'] })
    expect(family.found ? [] : family.nearest.map((n) => n.id)).toEqual(expect.arrayContaining(['pi4', 'pi5']))
    const typo = matchParts(table(), '6080')
    expect(typo.found ? [] : typo.nearest.map((n) => n.id)[0]).toBe('608')
    expect(matchParts(table(), 'Galaxy S24')).toEqual({ found: false, nearest: [], categories: [] })
  })
})

describe('parts.lookup', () => {
  const ctx = {} as ToolContext
  const run = async (input: Record<string, unknown>) => {
    const tool = partsTool(table())
    return tool.run(tool.input.parse(input) as never, ctx)
  }

  it('is a read tool in the knowledge set', () => {
    const tool = partsTool(table())
    expect(tool).toMatchObject({ name: 'parts.lookup', permission: 'read', source: 'kb' })
    expect(() => tool.input.parse({})).toThrow()
  })

  it('answers with each size, its unit and its source link, and cites the source', async () => {
    const out = await run({ name: '608ZZ' })
    expect(out.ok).not.toBe(false)
    expect(out.summary).toBe('608 bearing: bore 8 mm, outside diameter 22 mm, width 7 mm')
    const o = out.output as { found: boolean; parts: { id: string; sizes: { key: string; value: unknown; unit: string | null; source_url: string | null; status?: string; reason?: string }[] }[] }
    expect(o.found).toBe(true)
    expect(o.parts.map((p) => p.id)).toEqual(['608'])
    expect(o.parts[0]!.sizes.find((s) => s.key === 'bore')).toEqual({ key: 'bore', value: 8, unit: 'mm', source_url: NSK })
    expect(out.citations).toEqual([{ id: NSK, title: '608 bearing (nsk.com)', url: NSK, publisher: 'nsk.com', kind: 'kb' }])
  })

  it('gives a motor face with its limits and derived hole centers', async () => {
    const out = await run({ name: 'NEMA 17' })
    const sizes = (out.output as { parts: { sizes: { key: string; status?: string }[] }[] }).parts[0]!.sizes
    expect(sizes.find((s) => s.key === 'hole_centers')).toMatchObject({ status: 'derived' })
    expect(out.summary).toMatch(/^SOYO SY42STH38-1684A \(NEMA 17\): face square 42\.3 mm, maximum/)
  })

  it('says plainly when a part is not in the table, with the nearest entries and what to do next', async () => {
    const out = await run({ name: 'Galaxy S24' })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('"Galaxy S24" is not in the standard parts table')
    expect(out.output).toMatchObject({ found: false, query: 'Galaxy S24', nearest: [], hint: expect.stringMatching(/Ask the person which model .* web\.lookup .* memory/) })
    const family = await run({ name: 'Raspberry Pi' })
    expect(family.ok).toBe(false)
    expect(family.summary).toMatch(/nearest: .*Raspberry Pi 4 Model B/)
    expect((family.output as { hint: string }).hint).toMatch(/ask which one/)
  })

  it('tells a case or holder built around a phone that its pocket is at least the phone deep', async () => {
    const scope = (out: Awaited<ReturnType<typeof run>>) => (out.output as { parts: { scope?: string }[] }).parts[0]!.scope
    const out = await run({ name: 'iPhone 15' })
    expect(out.summary).toBe('Apple iPhone 15: height 147.6 mm, width 71.6 mm, depth 7.8 mm')
    expect(scope(out)).toMatch(/pocket at least the phone's depth deep, plus clearance\.$/)
    expect(scope(lookupParts(await bundledPartsTable(), 'iPhone 15'))).toMatch(/pocket at least the phone's depth deep, plus clearance\.$/)
  })

  it('shows the one part it found as a card in the view, with its sizes and the page they came from', async () => {
    const out = await run({ name: 'iPhone 15' })
    expect(out.lookup).toEqual({
      title: 'Apple iPhone 15',
      fields: [['height', '147.6 mm'], ['width', '71.6 mm'], ['depth', '7.8 mm']],
      source: { title: 'Apple iPhone 15 (support.apple.com)', url: 'https://support.apple.com/en-us/111831' },
    })
    // a family of several parts, or none, shows no card: the model asks which one
    expect((await run({ name: 'Raspberry Pi' })).lookup).toBeUndefined()
    expect((await run({ name: 'Galaxy S24' })).lookup).toBeUndefined()
  })

  it('shows no card for a near name, only for a name the request is all about', async () => {
    const bundled = await bundledPartsTable()
    // whole word matching finds the iPhone 15 and the Pixel 8 Pro in these, but neither is the phone asked for
    for (const near of ['iPhone 15 mini', 'Pixel 8 Pro Fold']) {
      const out = lookupParts(bundled, near)
      expect(out.ok, near).not.toBe(false)
      expect(out.lookup, near).toBeUndefined()
    }
    // the exact name, its full name, and the name with a few words around it still show the card
    for (const exact of ['iPhone 15', 'Apple iPhone 15', 'a case for my iPhone 15', 'Pixel 8 Pro phone holder']) expect(lookupParts(bundled, exact).lookup?.title, exact).toMatch(/^(Apple iPhone 15|Google Pixel 8 Pro)$/)
  })

  it('a lookup in a chat puts the card in the view', async () => {
    const pilot = createPilot({
      host: { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport },
      config: { ...DEFAULT_CONFIG, webSearch: false },
      policy: DEFAULT_POLICY,
      client: createScriptedClient([{ calls: [{ name: 'parts.lookup', args: { name: 'iPhone 15' } }] }, { text: 'Found it.' }], { chunk: false }),
      builtins: false,
      tools: [partsTool(table())],
    })
    const events: { type: string }[] = []
    for await (const e of pilot.run('s', 'case for my iPhone 15')) events.push(e)
    expect(events.filter((e) => e.type === 'lookup')).toEqual([{ type: 'lookup', lookup: expect.objectContaining({ id: expect.stringMatching(/^lk_/), title: 'Apple iPhone 15' }) }])
  })

  it('a lookup.show of the same page in that turn adds no second card, and one of another page does', async () => {
    const show = (url: string) => ({ name: 'lookup.show', args: { title: 'iPhone 15 size', fields: [['Depth', '7.8 mm']], source: { title: 'Apple', url } } })
    const pilot = createPilot({
      host: { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport },
      config: { ...DEFAULT_CONFIG, webSearch: false },
      policy: DEFAULT_POLICY,
      client: createScriptedClient([{ calls: [{ name: 'parts.lookup', args: { name: 'iPhone 15' } }] }, { calls: [show('https://support.apple.com/en-us/111831')] }, { calls: [show('https://example.com/iphone-15')] }, { text: 'Done.' }], { chunk: false }),
      builtins: false,
      tools: [partsTool(table()), lookupTool()],
    })
    const events: { type: string; lookup?: { title: string } }[] = []
    for await (const e of pilot.run('s', 'case for my iPhone 15')) events.push(e as never)
    expect(events.filter((e) => e.type === 'lookup').map((e) => e.lookup!.title)).toEqual(['Apple iPhone 15', 'iPhone 15 size'])
  })

  it('writes values the way people read them', () => {
    expect(sizeText({ key: 'bore', value: 8, unit: 'mm', source_url: NSK })).toBe('8 mm')
    expect(sizeText({ key: 'outline_xy', value: [85, 56], unit: 'mm', source_url: NSK })).toBe('85 x 56 mm')
    expect(sizeText({ key: 'c', value: [[3.5, 3.5], [61.5, 3.5]], unit: 'mm', source_url: NSK })).toBe('(3.5, 3.5), (61.5, 3.5) mm')
    expect(sizeText({ key: 'f', value: 'm*z', unit: 'formula:mm', source_url: NSK })).toBe('m*z (formula, mm)')
    expect(sizeText({ key: 'n', value: 4, unit: 'count', source_url: NSK })).toBe('4')
    expect(sizeText({ key: 's', value: 42.3, unit: 'mm', source_url: NSK, limit: 'maximum' })).toBe('42.3 mm, maximum')
    expect(sizeText({ key: 'g', value: null, unit: null, source_url: null, status: 'unsourced' })).toBe('not published')
  })

  it('looks up in the bundled table by default', async () => {
    const bundled = await bundledPartsTable()
    const tool = partsTool()
    const out = await tool.run(tool.input.parse({ name: '608' }) as never, ctx)
    expect(out.ok === false).toBe(!bundled.records.some((r) => r.id === '608'))
    expect(lookupParts(bundled, 'no such part at all').ok).toBe(false)
  })
})

describe('where mimir has parts.lookup, and what the prompt says about it', () => {
  it('is in the full toolset, the browser build and the mimir tab', () => {
    expect(builtinTools({ planner: undefined, commands: [] }).map((t) => t.name)).toContain('parts.lookup')
    expect(CAD_TOOLS.has('parts.lookup')).toBe(true)
    const pilot = createPilot({
      host: { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport },
      config: { ...DEFAULT_CONFIG, webSearch: false },
      policy: DEFAULT_POLICY,
      client: createScriptedClient([]),
      tools: [defineTool({ name: 'design.new', version: '1.0.0', source: 'command', permission: 'read', description: 'design.new for the test', input: z.object({}), async run() { return { summary: 'ok' } } }) as PilotTool<never>],
    })
    expect(pilot.tools().map((t) => t.name)).toContain('parts.lookup')
  })

  it('tells the model in every scope to look a named part up before building and to name each size\'s source', () => {
    expect(PARTS_LINE).toMatch(/call parts\.lookup before building and cite each size's source; if not found, ask or look it up\./)
    // one sentence, kept short: a local model's context holds the whole prompt and every tool
    expect(PARTS_LINE.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(2)
    for (const scope of ['full', 'cad'] as const) for (const designs of [true, false]) expect(systemPrompt(scope, (n) => designs || n !== 'design.new')).toContain(PARTS_LINE)
  })
})
