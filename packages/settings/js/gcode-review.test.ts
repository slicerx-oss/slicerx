// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { gcodeFingerprint, isStockGcode, normalizeGcode, reviewProjectGcode } from './gcode-review'
import { printerConfig } from './profiles'
import { sha256Hex } from './sha256'

const a1 = printerConfig('bambu-a1') as unknown as Record<string, string>
const start = a1['machine_start_gcode']!
const end = a1['machine_end_gcode']!

describe('SHA-256', () => {
  it('matches the standard test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    for (const t of ['déjà vu', start]) expect(sha256Hex(t)).toBe(createHash('sha256').update(t).digest('hex'))
  })
})

describe('stock G-code', () => {
  it('is the Bambu Lab A1 start G-code as SlicerX ships it, with M211, M500 and M18 in it', () => {
    expect(start).toMatch(/^M211 X0 Y0 Z0/m)
    expect(start).toMatch(/^\s*M500/m)
    expect(start).toMatch(/^M18/m)
    expect(isStockGcode('bambu-a1', 'machine_start_gcode', start)).toBe(true)
    // Line endings, trailing spaces and blank lines do not count.
    const crlf = start.split('\n').map((l) => `${l}  `).join('\r\n\r\n')
    expect(normalizeGcode(crlf)).toBe(normalizeGcode(start))
    expect(isStockGcode('bambu-a1', 'machine_start_gcode', crlf)).toBe(true)
    // Stock for the A1 is not stock for another printer.
    expect(isStockGcode('bambu-x1-carbon', 'machine_start_gcode', start)).toBe(false)
    expect(isStockGcode(undefined, 'machine_start_gcode', start)).toBe(false)
  })

  it('knows versions Bambu Studio and OrcaSlicer shipped before', async () => {
    const stock = (await import('../profiles/stock-gcode.json')).default as unknown as { models: Record<string, Record<string, string[]>> }
    expect(stock.models['bambu-a1']!['machine_start_gcode']!.length).toBeGreaterThan(5)
    // The text SlicerX ships is one of them.
    expect(stock.models['bambu-a1']!['machine_start_gcode']).toContain(gcodeFingerprint(start))
  })
})

describe('a project with its own G-code', () => {
  it('keeps stock text without asking', () => {
    const r = reviewProjectGcode({ project: { machine_start_gcode: start, machine_end_gcode: end }, profile: a1, model: 'bambu-a1' })
    expect(r.changes).toEqual([])
    expect(r.kept.map((k) => k.message)).toEqual(['matches the stock Bambu Lab A1 start G-code', 'matches the stock Bambu Lab A1 end G-code'])
  })

  it('shows the diff of changed text with the added M500 flagged', () => {
    const edited = start.replace('M1002 gcode_claim_action : 2', 'M1002 gcode_claim_action : 2\nM500 ; keep my offsets\nM104 S180')
    const r = reviewProjectGcode({ project: { machine_start_gcode: edited, machine_end_gcode: end }, profile: a1, model: 'bambu-a1', limits: { nozzleMaxC: 300, bedMaxC: 100 } })
    expect(r.kept.map((k) => k.key)).toEqual(['machine_end_gcode'])
    expect(r.changes).toHaveLength(1)
    const c = r.changes[0]!
    expect(c).toMatchObject({ key: 'machine_start_gcode', label: 'start G-code', added: 2, removed: 0, approvable: true, fingerprint: gcodeFingerprint(edited) })
    // Only the added line is flagged: the stock M500, M211 and M18 lines are the profile's own text.
    expect(c.flags).toEqual([{ line: 10, code: 'eeprom_write', reason: "M500 writes settings to the printer's memory", severity: 'warning' }])
    const added = c.diff.filter((d) => d.kind === 'added')
    expect(added.map((d) => d.text)).toEqual(['M500 ; keep my offsets', 'M104 S180'])
    expect(added[0]!.flags?.[0]?.code).toBe('eeprom_write')
    expect(c.diff[0]).toMatchObject({ kind: 'skip' })
    expect(c.diff.filter((d) => d.kind === 'same')).toHaveLength(6)
    expect(c.unified).toMatch(/^--- printer profile\n\+\+\+ project\n@@ -6,6 \+6,8 @@\n/)
    expect(c.unified).toMatch(/\n\+M500 ; keep my offsets\n\+M104 S180\n/)
  })

  it('cannot be approved when a line is beyond what a person may approve', () => {
    const edited = `${start}\nSAVE_CONFIG\nM104 S400`
    const c = reviewProjectGcode({ project: { machine_start_gcode: edited }, profile: a1, model: 'bambu-a1', limits: { nozzleMaxC: 300 } }).changes[0]!
    expect(c.flags.map((f) => [f.code, f.severity])).toEqual([
      ['config_save', 'error'],
      ['nozzle_over_limit', 'error'],
    ])
    expect(c.approvable).toBe(false)
  })

  it('flags a whole-section problem the profile does not have', () => {
    const c = reviewProjectGcode({ project: { machine_end_gcode: 'G1 Z10\nM140 S0' }, profile: a1, model: 'bambu-a1' }).changes[0]!
    expect(c.flags.map((f) => [f.code, f.severity])).toEqual([['end_leaves_heaters_on', 'error']])
    expect(c.approvable).toBe(false)
  })

  it('reviews per-filament G-code by filament', () => {
    const r = reviewProjectGcode({ project: { filament_start_gcode: ['; filament start gcode\n', 'M302 P1'] }, profile: { filament_start_gcode: ['; filament start gcode\n'] }, model: 'bambu-a1' })
    expect(r.kept.map((k) => k.label)).toEqual(['filament start G-code (filament 1)'])
    expect(r.changes.map((c) => [c.label, c.slot, c.flags.map((f) => f.code)])).toEqual([['filament start G-code (filament 2)', 1, ['cold_extrusion']]])
  })
})
