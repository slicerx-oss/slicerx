// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project's own printer G-code: stock text slices as it is, anything else comes back as a diff with its
// flagged lines for a person to see, and no tool call can approve it. The project is made from SlicerX's own A1 profile.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { printerConfig } from '@slicerx/settings'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="20" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="20" z="10"/><vertex x="0" y="20" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`

const a1 = printerConfig('bambu-a1') as unknown as Record<string, string>
const STOCK_START = a1['machine_start_gcode']!
const EDITED_START = STOCK_START.replace('M1002 gcode_claim_action : 2', 'M1002 gcode_claim_action : 2\nM500 ; keep my offsets')

/** A Bambu Studio style A1 project whose settings carry the A1 start and end G-code SlicerX ships. */
function a1Project(dir: string, name: string, start: string): string {
  const path = join(dir, name)
  writeFileSync(
    path,
    writeZip([
      { name: '3D/3dmodel.model', data: MODEL },
      {
        name: 'Metadata/project_settings.config',
        data: JSON.stringify({
          printer_settings_id: 'Bambu Lab A1 0.4 nozzle',
          printer_model: 'Bambu Lab A1',
          filament_settings_id: ['Bambu PLA Basic @BBL A1'],
          filament_type: ['PLA'],
          // Bambu Studio writes Windows line breaks on Windows.
          machine_start_gcode: start.replace(/\n/g, '\r\n'),
          machine_end_gcode: a1['machine_end_gcode'],
          layer_change_gcode: a1['layer_change_gcode'],
        }),
      },
    ]),
  )
  return path
}

type Err = { error: { code: string; message: string; details?: { summary?: string; printer?: string; approvable: boolean; changes: { key: string; label: string; added: number; approvable: boolean; flags: { line: number; code: string; reason: string; severity: string }[]; diff: string }[] } } }
type Summary = { project_gcode?: { key: string; use: string; message: string }[]; gcode_path: string }

describe('a project with its own printer G-code', () => {
  it.skipIf(noSx())('explicitly replaces one imported script, retains the original and keeps the input file intact', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const model = join(h.dir, 'replacement.3mf')
      const original = 'M400 U1\nM500'
      writeFileSync(model, writeZip([
        { name: '3D/3dmodel.model', data: MODEL },
        { name: 'Metadata/project_settings.config', data: JSON.stringify({ printer_model: 'Bambu Lab P1S', gcode_flavor: 'marlin', layer_height: '0.2', machine_pause_gcode: original }) },
      ]))
      const before = readFileSync(model)
      const args = { model, project_settings: true, script_printer: { model: 'bambu-p1s', firmware: 'marlin' }, script_replacements: [{ key: 'machine_pause_gcode', original, replacement: 'M400 U1' }] }
      const result = await h.call('slicerx_slice_file', args)
      expect(result.isError, text(result)).toBeFalsy()
      const output = data<{ layer_count: number; script_replacements: { original: string; replacement: string; decision: string; diff: unknown[] }[] }>(result)
      expect(output.layer_count).toBeGreaterThan(0)
      expect(output.script_replacements).toHaveLength(1)
      expect(output.script_replacements[0]).toMatchObject({ original, replacement: 'M400 U1', decision: 'applied' })
      expect(output.script_replacements[0]!.diff.length).toBeGreaterThan(0)
      expect(readFileSync(model)).toEqual(before)
      const stale = await h.call('slicerx_slice_file', { ...args, script_replacements: [{ ...args.script_replacements[0], original: 'stale' }] })
      expect(data<Err>(stale).error.code).toBe('script_replacement_stale')
      const overridden = await h.call('slicerx_slice_file', { ...args, overrides: { machine_pause_gcode: 'G4 P0' } })
      expect(data<Err>(overridden).error.code).toBe('script_replacement_stale')
      const changed = await h.call('slicerx_slice_file', { ...args, script_replacements: [{ ...args.script_replacements[0], replacement: 'M400 U1\nM500' }] })
      expect(changed.isError).toBe(true)
    } finally { await h.client.close() }
  })
  it('keeps the stock A1 start G-code with M211, M500 and M18 in it, trusted, and says so', async () => {
    expect(STOCK_START).toMatch(/^M211 /m)
    expect(STOCK_START).toMatch(/^\s*M500/m)
    expect(STOCK_START).toMatch(/^M18/m)
    const h = await connect()
    const read = readProjectFile(a1Project(h.dir, 'stock.3mf', STOCK_START))
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'stock.3mf', config: read.config, model: 'bambu-a1' } })
    expect(r.trustedGcode).toBe(true)
    expect(r.gcodeKept.map((k) => [k.key, k.match, k.message])).toEqual([
      ['machine_start_gcode', 'stock', 'matches the stock Bambu Lab A1 start G-code'],
      ['machine_end_gcode', 'stock', 'matches the stock Bambu Lab A1 end G-code'],
      ['layer_change_gcode', 'stock', 'matches the stock Bambu Lab A1 layer change G-code'],
    ])
    expect(String(r.config['machine_start_gcode'])).toMatch(/^M211 X0 Y0 Z0/m)
  })

  it('refuses changed G-code with the diff and the M500 it adds flagged', async () => {
    const h = await connect()
    const r = await h.call('slicerx_slice_file', { model: a1Project(h.dir, 'edited.3mf', EDITED_START), project_settings: true })
    const e = data<Err>(r).error
    expect(e.code).toBe('project_gcode_review')
    // One plain line and what to do; the counts and flagged lines are in details only.
    expect(e.message).toBe(`edited.3mf's printer G-code doesn't match the Bambu Lab A1 profile's. Show the person the differences in details, or call again with project_gcode "profile" to use the printer's G-code.`)
    expect(text(r)).toBe(`Error: project_gcode_review: ${e.message}`)
    expect(e.details?.summary).toBe("edited.3mf's printer G-code doesn't match the Bambu Lab A1 profile's.")
    expect(e.details?.printer).toBe('bambu-a1')
    expect(e.details?.approvable).toBe(true)
    const c = e.details!.changes[0]!
    expect(c).toMatchObject({ key: 'machine_start_gcode', label: 'start G-code', added: 1, approvable: true })
    expect(c.flags).toEqual([{ line: 10, code: 'eeprom_write', reason: "M500 writes settings to the printer's memory", severity: 'warning' }])
    expect(c.diff).toMatch(/\n\+M500 ; keep my offsets\n/)
    // The stock lines around it are not flagged.
    expect(c.flags.some((f) => f.code === 'endstops' || f.code === 'motors_off')).toBe(false)
  })

  it('asks for the printer when no printer was named and the project names none SlicerX has', async () => {
    const h = await connect()
    const path = join(h.dir, 'mystery.3mf')
    writeFileSync(
      path,
      writeZip([
        { name: '3D/3dmodel.model', data: MODEL },
        { name: 'Metadata/project_settings.config', data: JSON.stringify({ printer_settings_id: 'Workshop Special 0.4 nozzle', machine_start_gcode: 'G28\nG1 Z5 F3000\nM104 S200\n' }) },
      ]),
    )
    const r = await h.call('slicerx_slice_file', { model: path, project_settings: true })
    const e = data<Err>(r).error
    expect(e.code).toBe('printer_needed')
    expect(e.message).toBe(`mystery.3mf has its own printer G-code, and no printer was named to check it against. Name the printer profile the project is for, or call again with project_gcode "profile".`)
    expect(e.details?.summary).toBe('mystery.3mf has its own printer G-code, and no printer was named to check it against.')
    // The printer profile's G-code still slices it.
    const read = readProjectFile(path)
    const kept = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'mystery.3mf', config: read.config, gcode: 'profile' } })
    expect(kept.gcodeReplaced).toEqual(['machine_start_gcode'])
  })

  it("leaves the printer profile's G-code in place of changed text when asked to", async () => {
    const h = await connect()
    const read = readProjectFile(a1Project(h.dir, 'edited.3mf', EDITED_START))
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'edited.3mf', config: read.config, model: 'bambu-a1', gcode: 'profile' } })
    expect(r.gcodeReplaced).toEqual(['machine_start_gcode'])
    expect(r.config['machine_start_gcode']).toBe(STOCK_START)
    expect(r.trustedGcode).toBe(true)
  })

  it('leaves G-code that a printer profile in the call sets over the project to that profile', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:bambu-x1-carbon'])
    const read = readProjectFile(a1Project(h.dir, 'edited.3mf', EDITED_START))
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:bambu-x1-carbon'], undefined, { project: { name: 'edited.3mf', config: read.config, model: 'bambu-a1' } })
    // The layer change G-code is the same text on both printers, so it is stock for the X1 Carbon as well.
    expect(r.gcodeKept.map((k) => k.message)).toEqual(['matches the stock Bambu Lab X1 Carbon layer change G-code'])
    expect(r.config['machine_start_gcode']).not.toMatch(/keep my offsets/)
    expect(r.trustedGcode).toBe(true)
  })
})

const cc = printerConfig('elegoo-centauri-carbon') as unknown as Record<string, string>

/** An OrcaSlicer style Elegoo Centauri Carbon project with the given start G-code and the stock end G-code. */
function ccProject(dir: string, name: string, start: string): string {
  const path = join(dir, name)
  writeFileSync(
    path,
    writeZip([
      { name: '3D/3dmodel.model', data: MODEL },
      {
        name: 'Metadata/project_settings.config',
        data: JSON.stringify({ printer_settings_id: 'Elegoo Centauri Carbon 0.4 nozzle', printer_model: 'Elegoo Centauri Carbon', filament_type: ['PLA'], machine_start_gcode: start.replace(/\n/g, '\r\n'), machine_end_gcode: cc['machine_end_gcode'] }),
      },
    ]),
  )
  return path
}

describe('an Elegoo Centauri Carbon project with its own printer G-code', () => {
  it('keeps the stock start and end G-code and says so', async () => {
    const h = await connect()
    const read = readProjectFile(ccProject(h.dir, 'stock-cc.3mf', cc['machine_start_gcode']!))
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'stock-cc.3mf', config: read.config, model: 'elegoo-centauri-carbon' } })
    expect(r.gcodeKept.map((k) => [k.key, k.match, k.message])).toEqual([
      ['machine_start_gcode', 'stock', 'matches the stock Elegoo Centauri Carbon start G-code'],
      ['machine_end_gcode', 'stock', 'matches the stock Elegoo Centauri Carbon end G-code'],
    ])
    expect(r.trustedGcode).toBe(true)
  })

  it('refuses a changed start G-code with the diff, compared with the Centauri Carbon', async () => {
    const h = await connect()
    const edited = `${cc['machine_start_gcode']!}\nM500 ; keep my offsets`
    const r = await h.call('slicerx_slice_file', { model: ccProject(h.dir, 'edited-cc.3mf', edited), project_settings: true })
    const e = data<Err>(r).error
    expect(e.code).toBe('project_gcode_review')
    expect(e.details?.summary).toBe("edited-cc.3mf's printer G-code doesn't match the Elegoo Centauri Carbon profile's.")
    expect(e.details?.printer).toBe('elegoo-centauri-carbon')
    const c = e.details!.changes[0]!
    expect(c).toMatchObject({ key: 'machine_start_gcode', added: 1, approvable: true })
    expect(c.flags.map((f) => f.code)).toEqual(['eeprom_write'])
    expect(e.details!.changes.map((x) => x.key)).toEqual(['machine_start_gcode'])
  })
})

describe.skipIf(noSx())('with the real sx CLI', { timeout: sxTimeout }, () => {
  it('slices the stock A1 project with no question, the stock start in the G-code', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: a1Project(h.dir, 'stock.3mf', STOCK_START), project_settings: true })
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toMatch(/The project's start G-code matches the stock Bambu Lab A1 start G-code\./)
    const gcode = readFileSync(data<Summary>(r).gcode_path, 'utf8')
    expect(gcode).toMatch(/^M211 X0 Y0 Z0 ;turn off soft endstop/m)
    expect(gcode).toMatch(/^\s*M500 ; save cali data/m)
  })

  it("slices the edited project with the profile's G-code, without the added M500", async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: a1Project(h.dir, 'edited.3mf', EDITED_START), project_settings: true, project_gcode: 'profile' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<Summary>(r).project_gcode?.find((g) => g.key === 'machine_start_gcode')).toEqual({ key: 'machine_start_gcode', use: 'profile', message: "Used the printer profile's start G-code instead of the project's." })
    expect(readFileSync(data<Summary>(r).gcode_path, 'utf8')).not.toMatch(/keep my offsets/)
  })
})
