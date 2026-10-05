// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Setup step 2 and Settings > Presets import: real OrcaSlicer 2.4.2 and Bambu Studio 2.8.2 bundles from
// packages/settings/fixtures/preset-files, loose user preset files, PrusaSlicer files, the report shown after an
// import, and the limits on untrusted bundles.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { HostContext } from '../src/host'
import { importPresetFile } from '../src/first-run/preset-import'
import { zip, zipCompressed } from '../src/export/zip'
import { BUNDLE_LIMITS, importPresetSources, importReportText } from '../src/presets/import-files'
import { importSummary } from '../src/presets/import-result'
import { ImportReportView } from '../src/presets/import-report'
import { memoryStore, setPresetStore } from '../src/presets/store'
import { get, set } from '../src/state/store'

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '../../settings/fixtures/preset-files', name)))
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))

beforeEach(() => {
  setPresetStore(memoryStore())
  set({ overrides: {}, userPresets: [], activePresets: {}, profile: null, settingsMode: 'simple' })
})

describe('preset bundles', () => {
  it('imports an OrcaSlicer printer bundle with names and printer links, without switching to it', async () => {
    const results = await importPresetFile(fixture('orca-2.4.2-printer.orca_printer'), 'My A1 0.4 nozzle.orca_printer')
    expect(results.map((r) => [r.ok, r.kind, r.name])).toEqual([
      [true, 'printer', 'My A1 0.4 nozzle'],
      [true, 'filament', 'My PLA Basic @BBL A1'],
      [true, 'process', 'My 0.20mm Standard @BBL A1'],
    ])
    const saved = get().userPresets
    expect(saved.find((p) => p.kind === 'process')).toMatchObject({ inherits: '0.20mm Standard @BBL A1', printer: 'My A1 0.4 nozzle', values: { wall_loops: 3, sparse_infill_density: 20 } })
    expect(saved.find((p) => p.kind === 'filament')!.printer).toBe('My A1 0.4 nozzle')
    expect(get().activePresets).toEqual({})
    expect(get().overrides).toEqual({})
    expect(importSummary(results)).toBe('3 presets imported')
  })

  it('imports a Bambu Studio printer bundle and reports what did not carry over', async () => {
    const results = await importPresetFile(fixture('bambu-studio-2.8.2-printer.bbscfg'), 'My A1 mini 0.4 nozzle.bbscfg')
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results).toHaveLength(5)
    const process = results.find((r) => r.kind === 'process')!
    expect(process.skipped).toBe(3)
    expect(process.report!.items.map((i) => i.label)).toEqual(['Infill pattern', 'Only one wall on top surfaces', 'Slow down by height'])
    // Most of what did not carry over is the Bambu Studio only keys of the filament made with Create filament.
    const total = results.reduce((n, r) => n + r.skipped, 0)
    expect(total).toBeGreaterThan(5)
    expect(importSummary(results)).toBe(`5 presets imported, ${total} settings did not carry over`)
    const text = await importReportText(results, false)
    expect(text).toContain('My 0.20mm Standard @BBL A1M (process preset)')
    expect(text).toContain('Only one wall on top surfaces: all top. SlicerX has no such setting. Nearest equivalent is Single wall on the top surface')
    expect(text).not.toContain('top_one_wall_type')
    expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`))
  })

  it('keeps links pointing at a printer renamed to stay unique', async () => {
    await importPresetFile(fixture('orca-2.4.2-printer.orca_printer'), 'a.orca_printer')
    await importPresetFile(fixture('orca-2.4.2-printer.orca_printer'), 'b.orca_printer')
    const second = get().userPresets.filter((p) => p.kind === 'process').map((p) => p.printer).sort()
    expect(second).toEqual(['My A1 0.4 nozzle', 'My A1 0.4 nozzle 2'])
  })

  it('imports filament bundles from both apps', async () => {
    const orca = await importPresetFile(fixture('orca-2.4.2-filament.orca_filament'), 'My PLA Basic.orca_filament')
    expect(orca.map((r) => r.name)).toEqual(['My PLA Basic @BBL A1'])
    const bambu = await importPresetFile(fixture('bambu-studio-2.8.2-filament.bbsflmt'), 'Matte Works PLA.bbsflmt')
    expect(bambu.map((r) => r.name)).toEqual(['Matte Works PLA @My A1 mini 0.4 nozzle', 'Matte Works PLA Tuned'])
    expect(bambu[1]!.report!.parent).toEqual({ name: 'Matte Works PLA @My A1 mini 0.4 nozzle', found: true, bundled: true })
  })
})

describe('loose preset files', () => {
  it('reads user presets that carry no type, and files picked together find their parents among them', async () => {
    const base = { name: 'Matte @A1M', inherits: '', from: 'User', filament_settings_id: ['Matte @A1M'], filament_id: 'P1', nozzle_temperature: ['212'], filament_type: ['PLA'] }
    const tuned = { name: 'Matte Tuned', inherits: 'Matte @A1M', from: 'User', filament_settings_id: ['Matte Tuned'], filament_flow_ratio: ['0.95'] }
    const results = await importPresetSources([
      { name: 'Matte Tuned.json', bytes: json(tuned) },
      { name: 'Matte @A1M.json', bytes: json(base) },
    ])
    expect(results.map((r) => r.name).sort()).toEqual(['Matte @A1M', 'Matte Tuned'])
    const t = get().userPresets.find((p) => p.name === 'Matte Tuned')!
    expect(t.values).toMatchObject({ nozzle_temperature: [212], filament_flow_ratio: [0.95] })
  })

  it('takes the kind from the folder an installed preset came from', async () => {
    const results = await importPresetFile(JSON.stringify({ name: 'Odd', wall_loops: '5' }), 'Odd.json', 'process')
    expect(results[0]).toMatchObject({ ok: true, kind: 'process', name: 'Odd' })
  })

  it('imports PrusaSlicer files with a report', async () => {
    const results = await importPresetFile('[filament:My PETG]\ntemperature = 240\nfan_always_on = 1\n', 'bundle.ini')
    expect(results[0]).toMatchObject({ ok: true, kind: 'filament', name: 'My PETG', skipped: 1 })
    expect(results[0]!.report!.items[0]!.instead?.label).toBe('Avoid stopping the fan between layers')
  })

  it('says plainly what is wrong with a file', async () => {
    expect((await importPresetFile('nope', 'x.json'))[0]!.message).toBe('That file is not valid JSON.')
    expect((await importPresetFile('{"name":"x"}', 'x.json'))[0]!.message).toMatch(/not a SlicerX, OrcaSlicer, Bambu Studio or PrusaSlicer preset/)
    expect((await importPresetFile('not a zip at all', 'x.bbscfg'))[0]!.message).toBe('This is not a preset bundle.')
  })
})

describe('untrusted bundles', () => {
  it('refuses a path that climbs out of the bundle', async () => {
    const evil = zip([{ name: 'bundle_structure.json', data: '{}' }, { name: '../../escape.json', data: '{"name":"x","print_settings_id":"x"}' }])
    const [r] = await importPresetFile(evil, 'evil.orca_printer')
    expect(r).toMatchObject({ ok: false, message: 'The archive has a file with an unsafe path.' })
  })

  it('refuses entries that would inflate past the limits', async () => {
    const huge = 'a'.repeat(BUNDLE_LIMITS.entry + 1)
    const [r] = await importPresetFile(zip([{ name: 'process/a.json', data: huge }]), 'big.zip')
    expect(r).toMatchObject({ ok: false, message: 'The archive is too large to open.' })
  })

  it('refuses a header that lies about the inflated size (a zip bomb)', async () => {
    const bytes = await zipCompressed([{ name: 'process/a.json', data: JSON.stringify({ name: 'A', print_settings_id: 'A', notes: 'x'.repeat(200_000) }) }])
    // Claim 100 bytes for an entry that inflates to 200 KB, in the central directory the reader trusts.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let at = bytes.length - 22
    while (view.getUint32(at, true) !== 0x06054b50) at--
    const cd = view.getUint32(at + 16, true)
    expect(view.getUint16(cd + 10, true)).toBe(8)
    view.setUint32(cd + 24, 100, true)
    const [r] = await importPresetFile(bytes, 'bomb.zip')
    expect(r).toMatchObject({ ok: false, message: 'A file in the archive inflates to more than it declares.' })
  })

  it('refuses too many entries and a bundle file that is too large', async () => {
    const many = Array.from({ length: BUNDLE_LIMITS.entries + 1 }, (_, i) => ({ name: `p${i}.txt`, data: 'x' }))
    expect((await importPresetFile(zip(many), 'many.zip'))[0]).toMatchObject({ ok: false, message: 'The archive has too many files.' })
    const big = new Uint8Array(16 * 1024 * 1024 + 1)
    big.set([0x50, 0x4b, 3, 4])
    expect((await importPresetFile(big, 'big.bbscfg'))[0]).toMatchObject({ ok: false, message: 'That file is too large to be a preset bundle.' })
  })
})

describe('report view', () => {
  const render = async (results: Parameters<typeof ImportReportView>[0]['results']) => {
    const el = document.createElement('div')
    const root = createRoot(el)
    const host = { kind: 'web', capabilities: {}, files: { save: async () => null } } as never
    flushSync(() => root.render(createElement(HostContext.Provider, { value: host }, createElement(ImportReportView, { results }))))
    await new Promise((r) => setTimeout(r, 0))
    return { el, root }
  }

  it('shows labels per preset, folded, with keys only in developer mode', async () => {
    const results = await importPresetFile(fixture('bambu-studio-2.8.2-printer.bbscfg'), 'b.bbscfg')
    const { el, root } = await render(results)
    expect(el.querySelector('.imp-sum')?.textContent).toMatch(/5 presets imported, \d+ settings did not carry over/)
    expect(el.querySelectorAll('details.imp-preset')).toHaveLength(5)
    expect(el.querySelector('details.imp-preset[open]')).toBeNull()
    expect(el.textContent).toContain('Only one wall on top surfaces')
    expect(el.textContent).not.toContain('top_one_wall_type')
    expect(el.textContent).toContain('Save report')
    root.unmount()
    set({ settingsMode: 'developer' })
    const dev = await render(results)
    expect(dev.el.querySelector('.imp-key')?.textContent).toBeTruthy()
    expect(dev.el.textContent).toContain('top_one_wall_type')
    dev.root.unmount()
  })
})
