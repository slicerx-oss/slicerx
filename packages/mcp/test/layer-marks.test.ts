// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer marks of a project file: the reader and writer the app and the server share (@slicerx/threemf/layer-marks),
// and the server's edits of a 3MF's marks in place.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { layerMarksXml, markZ, placeMark, readLayerMarks, TOOL_CHANGE_MODE_SKIP, writeMarks } from '@slicerx/threemf/layer-marks'
import { addPlateMark, newMark, readPlateMarks, removePlateMark } from '../src/layer-marks-file'
import { readZip, writeZip } from '../src/zip'

const dir = mkdtempSync(join(tmpdir(), 'layer-marks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const MODEL = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>'
const TWO_PLATES = '<?xml version="1.0" encoding="UTF-8"?><config><plate><metadata key="plater_id" value="1"/></plate><plate><metadata key="plater_id" value="2"/></plate></config>'

function project(name: string, extra: { name: string; data: string }[] = []): string {
  const path = join(dir, name)
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: MODEL }, { name: 'Metadata/model_settings.config', data: TWO_PLATES }, ...extra]))
  return path
}

describe('the marks file', () => {
  it('reads back what it writes, per plate, with several lines of custom text and markup kept', () => {
    const xml = layerMarksXml({
      0: [{ z: 2, kind: 'pause' }, { z: 4.2, kind: 'color_change', slot: 3 }, { z: 6, kind: 'custom', gcode: 'M117 a <b> & "c"\nG4 P1000' }],
      1: [{ z: 5, kind: 'tool_change', slot: 2 }],
    })
    expect(xml).toContain('extra="M117 a &lt;b&gt; &amp; &quot;c&quot;&#10;G4 P1000"')
    expect(readLayerMarks(xml)).toEqual({
      0: [{ z: 2, kind: 'pause' }, { z: 4.2, kind: 'color_change', slot: 3 }, { z: 6, kind: 'custom', gcode: 'M117 a <b> & "c"\nG4 P1000' }],
      1: [{ z: 5, kind: 'tool_change', slot: 2 }],
    })
  })

  it('keeps a tool change saved for a plate of several filaments, and writes that mode again', () => {
    const xml = '<?xml version="1.0"?><custom_gcodes_per_layer><plate><plate_info id="1"/><layer top_z="5.0" type="2" extruder="2" color="" extra="" gcode="tool_change"/><mode value="MultiExtruder"/></plate></custom_gcodes_per_layer>'
    const read = readLayerMarks(xml)
    expect(read).toEqual({ 0: [{ z: 5, kind: 'tool_change', slot: 2, skip: TOOL_CHANGE_MODE_SKIP }] })
    const again = layerMarksXml({ 0: writeMarks(read[0]!) })
    expect(again).toContain('<mode value="MultiExtruder"/>')
    expect(readLayerMarks(again)).toEqual(read)
  })

  it('leaves out heights of 0 or less, unknown types and plates without a number, and reads what it can of damaged text', () => {
    const xml = '<custom_gcodes_per_layer><plate><plate_info id="1"/><layer top_z="0" type="1"/><layer top_z="3" type="3"/><layer top_z="4" type="1"/><layer top_z="5" type="4" gcode="M117 x"/></plate><plate><layer top_z="2" type="1"/></plate><plate><plate_info id="3"/><layer top_z="1" type="1"'
    expect(readLayerMarks(xml)).toEqual({ 0: [{ z: 4, kind: 'pause' }, { z: 5, kind: 'custom', gcode: 'M117 x' }] })
    expect(readLayerMarks('not xml')).toEqual({})
    expect(layerMarksXml({ 0: [] })).toBe('')
  })

  it('keeps one mark per height, by height', () => {
    expect(markZ(1.23456789)).toBe(1.2346)
    const marks = placeMark(placeMark([{ z: 4 }, { z: 2 }], { z: 3 }), { z: 4.0000001 })
    expect(marks.map((m) => m.z)).toEqual([2, 3, 4.0000001])
  })
})

describe('a mark checked as the app checks it', () => {
  it('refuses printer-changing or overheating text and stray fields, and trims custom text', () => {
    expect(() => newMark({ z: 2, kind: 'custom', gcode: 'M500' })).toThrow('printer memory')
    expect(() => newMark({ z: 2, kind: 'custom', gcode: 'M104 S400' })).toThrow('hotter')
    expect(() => newMark({ z: 2, kind: 'custom' })).toThrow('Enter the G-code')
    expect(() => newMark({ z: 2, kind: 'pause', slot: 2 })).toThrow('color change only')
    expect(() => newMark({ z: 2, kind: 'pause', gcode: 'M117' })).toThrow('custom G-code mark only')
    expect(newMark({ z: 2.000001, kind: 'custom', gcode: '  M117 hi\n' })).toEqual({ z: 2, kind: 'custom', gcode: 'M117 hi' })
    expect(newMark({ z: 3, kind: 'color_change', slot: 2 })).toEqual({ z: 3, kind: 'color_change', slot: 2 })
  })
})

describe('marks edited in a project file', () => {
  it('adds, replaces and removes on one plate and leaves the other plate and every other part as they were', () => {
    const other = '<?xml version="1.0"?><custom_gcodes_per_layer><plate><plate_info id="2"/><layer top_z="7" type="1" extruder="1" color="" extra="" gcode=""/><mode value="SingleExtruder"/></plate></custom_gcodes_per_layer>'
    const path = project('edit.3mf', [{ name: 'Metadata/custom_gcode_per_layer.xml', data: other }, { name: 'Metadata/plate_1.png', data: 'png' }])
    expect(readPlateMarks(path, 1).marks).toEqual([])
    expect(addPlateMark(path, 1, { z: 2, kind: 'pause' }).marks).toEqual([{ z: 2, kind: 'pause' }])
    const r = addPlateMark(path, 1, { z: 2, kind: 'color_change', slot: 2 })
    expect(r.replaced).toEqual({ z: 2, kind: 'pause' })
    expect(r.marks).toEqual([{ z: 2, kind: 'color_change', slot: 2 }])
    addPlateMark(path, 1, { z: 1, kind: 'custom', gcode: 'M117 one\nM117 two' })
    const zip = readZip(readFileSync(path))
    expect(readLayerMarks(zip.text('Metadata/custom_gcode_per_layer.xml')!)).toEqual({
      0: [{ z: 1, kind: 'custom', gcode: 'M117 one\nM117 two' }, { z: 2, kind: 'color_change', slot: 2 }],
      1: [{ z: 7, kind: 'pause' }],
    })
    expect(zip.text('3D/3dmodel.model')).toBe(MODEL)
    expect(zip.text('Metadata/plate_1.png')).toBe('png')
    expect(removePlateMark(path, 1, 1).removed).toEqual({ z: 1, kind: 'custom', gcode: 'M117 one\nM117 two' })
    expect(() => removePlateMark(path, 1, 5)).toThrow('no mark at 5 mm; its marks are at 2 mm')
    removePlateMark(path, 1, 2)
    removePlateMark(path, 2, 7)
    expect(readZip(readFileSync(path)).names()).not.toContain('Metadata/custom_gcode_per_layer.xml')
  })

  it('refuses a plate the project lacks and a print file with sliced G-code', () => {
    const path = project('plates.3mf')
    expect(() => readPlateMarks(path, 3)).toThrow('has no plate 3; its plates are 1, 2')
    const sliced = project('print.gcode.3mf', [{ name: 'Metadata/plate_1.gcode', data: 'G28\n' }])
    expect(() => addPlateMark(sliced, 1, { z: 2, kind: 'pause' })).toThrow('holds sliced G-code')
    expect(readZip(readFileSync(sliced)).names()).not.toContain('Metadata/custom_gcode_per_layer.xml')
  })
})
