// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_preset_compare as a client calls it: two profiles or preset files of one kind side by side, or one against the
// maker preset it was made from or the stock settings. Groups and labels as the app's Compare presets lists them, with
// each setting's key for integrators.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, text } from './helpers'

interface Row { key: string; label: string; differs: boolean; a?: unknown; b?: unknown; aText: string; bText: string; lines?: { added: number; removed: number; unified: string } }
interface Out { section: string; a: { name: string }; b: { name: string }; differ: number; groups: { group: string; label: string; rows: Row[] }[] }
const rows = (o: Out) => o.groups.flatMap((g) => g.rows)

describe('slicerx_preset_compare', () => {
  it('lists what differs between two process profiles, by group, with labels, values and keys', async () => {
    const h = await connect()
    try {
      const r = await h.call('slicerx_preset_compare', { a: 'process:standard', b: 'process:fine' })
      expect(r.isError, text(r)).toBeFalsy()
      const o = data<Out>(r)
      expect(o.section).toBe('process')
      expect(o.differ).toBeGreaterThan(0)
      expect(o.differ).toBe(rows(o).length)
      const lh = rows(o).find((x) => x.key === 'layer_height')!
      expect(lh).toMatchObject({ label: 'Layer height', differs: true })
      expect(lh.aText).toMatch(/ mm$/)
      expect(lh.a).not.toEqual(lh.b)
      for (const g of o.groups) {
        expect(g.label).not.toMatch(/_/)
        for (const x of g.rows) expect(x.label).not.toMatch(/_/)
      }
    } finally {
      await h.client.close()
    }
  })

  it("compares a user's preset file with the maker preset it was made from, and with the stock settings", async () => {
    const h = await connect()
    try {
      const mine = join(h.dir, 'My PLA.json')
      writeFileSync(mine, JSON.stringify({ name: 'My PLA', inherits: 'Bambu PLA Basic @BBL A1', filament_settings_id: ['My PLA'], nozzle_temperature: ['231'] }))
      const parent = await h.call('slicerx_preset_compare', { a_file: mine, against: 'parent' })
      expect(parent.isError, text(parent)).toBeFalsy()
      const p = data<Out>(parent)
      expect(p.b.name).toBe('Bambu PLA Basic @BBL A1')
      expect(rows(p).map((x) => x.key)).toEqual(['nozzle_temperature'])
      expect(rows(p)[0]).toMatchObject({ label: 'Nozzle temperature', aText: '231 C' })
      const stock = data<Out>(await h.call('slicerx_preset_compare', { a_file: mine, against: 'stock', all: true }))
      expect(stock.section).toBe('filament')
      expect(rows(stock).length).toBeGreaterThan(rows(stock).filter((x) => x.differs).length)
      expect(rows(stock).filter((x) => x.differs).length).toBe(stock.differ)
    } finally {
      await h.client.close()
    }
  })

  it('gives the line diff of a G-code setting, the same one the project review uses', async () => {
    const h = await connect()
    try {
      const mine = join(h.dir, 'My A1.json')
      writeFileSync(mine, JSON.stringify({ type: 'machine', name: 'My A1', inherits: 'Bambu Lab A1 0.4 nozzle', machine_end_gcode: 'M104 S0\nG28 X\nM84 ; mine' }))
      const o = data<Out>(await h.call('slicerx_preset_compare', { a_file: mine, against: 'parent' }))
      const end = rows(o).find((x) => x.key === 'machine_end_gcode')!
      expect(end.label).toMatch(/end g-?code/i)
      // The lines describe what the second side has against the first.
      expect(end.lines!.unified).toContain('-M84 ; mine')
      expect(end.aText).toBe('3 lines')
    } finally {
      await h.client.close()
    }
  })

  it('refuses each bad call with its code and reason, before reading anything it does not need', async () => {
    const h = await connect()
    try {
      const pla = join(h.dir, 'My PLA.json')
      writeFileSync(pla, JSON.stringify({ name: 'My PLA', inherits: 'Bambu PLA Basic @BBL A1', filament_settings_id: ['My PLA'], nozzle_temperature: ['231'] }))
      const orphan = join(h.dir, 'Orphan.json')
      writeFileSync(orphan, JSON.stringify({ type: 'filament', name: 'Orphan', inherits: 'No Such PLA @Nowhere', nozzle_temperature: ['200'] }))
      const loose = join(h.dir, 'Loose.json')
      writeFileSync(loose, JSON.stringify({ type: 'filament', name: 'Loose', filament_settings_id: ['Loose'], nozzle_temperature: ['200'] }))
      const bundle = join(h.dir, 'two.zip')
      writeFileSync(bundle, writeZip([
        { name: 'a.json', data: JSON.stringify({ type: 'filament', name: 'One', filament_settings_id: ['One'], nozzle_temperature: ['200'] }) },
        { name: 'b.json', data: JSON.stringify({ type: 'filament', name: 'Two', filament_settings_id: ['Two'], nozzle_temperature: ['210'] }) },
      ]))
      const cases: [string, Record<string, unknown>, string, string][] = [
        ['no first preset', { b: 'process:fine' }, 'invalid_input', 'no_first'],
        ['a and a_file', { a: 'process:standard', a_file: pla, against: 'stock' }, 'invalid_input', 'two_firsts'],
        ['no second side', { a: 'process:standard' }, 'invalid_input', 'no_second'],
        ['b and against', { a: 'process:standard', b: 'process:fine', against: 'stock' }, 'invalid_input', 'two_seconds'],
        ['b_file and b', { a: 'process:standard', b: 'process:fine', b_file: pla }, 'invalid_input', 'two_seconds'],
        ['an unknown profile', { a: 'process:nope-nope', against: 'stock' }, 'unknown_profile', 'unknown_profile'],
        ['two kinds', { a: 'process:standard', b: 'machine:bambu-a1' }, 'invalid_input', 'kinds_differ'],
        ['a profile against a preset file of another kind', { a: 'process:standard', b_file: pla }, 'invalid_input', 'kinds_differ'],
        ['a bundle of several presets', { a_file: bundle, against: 'stock' }, 'invalid_input', 'several_presets'],
        ['the parent of a profile, which names none', { a: 'process:standard', against: 'parent' }, 'invalid_input', 'no_parent'],
        ['the parent of a preset file that names none', { a_file: loose, against: 'parent' }, 'invalid_input', 'no_parent'],
        ['a parent that does not ship', { a_file: orphan, against: 'parent' }, 'unknown_profile', 'parent_not_shipped'],
      ]
      for (const [what, args, code, reason] of cases) {
        const r = await h.call('slicerx_preset_compare', args)
        expect(r.isError, what).toBe(true)
        const e = data<{ error: { code: string; message: string; details?: { reason?: string } } }>(r).error
        expect(e.code, what).toBe(code)
        expect(e.details?.reason, what).toBe(reason)
      }
      const orphanMessage = data<{ error: { message: string } }>(await h.call('slicerx_preset_compare', { a_file: orphan, against: 'parent' })).error.message
      expect(orphanMessage).toContain('"No Such PLA @Nowhere"')
      // A shipped parent goes through.
      const ok = await h.call('slicerx_preset_compare', { a_file: pla, against: 'parent' })
      expect(ok.isError, text(ok)).toBeFalsy()
    } finally {
      await h.client.close()
    }
  })
})
