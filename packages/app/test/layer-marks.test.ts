// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { addMark, customGcodeProblem, layerGcodeByHeight, marksFor, removeMark } from '../src/plate/layer-marks'
import { get, set, type PlateEntry } from '../src/state/store'

describe('layer marks', () => {
  beforeEach(() => set({ layerMarks: {}, activePlate: 'plate-1' }))

  it('refuses G-code that changes the printer or overheats it, and accepts plain text', () => {
    expect(customGcodeProblem('')).toContain('Enter')
    expect(customGcodeProblem('M500')).toContain('printer memory')
    expect(customGcodeProblem('SAVE_CONFIG')).toContain('configuration')
    expect(customGcodeProblem('M104 S400')).toContain('hotter')
    expect(customGcodeProblem('M140 S140')).toContain('hotter')
    expect(customGcodeProblem('M84')).toContain('motors')
    expect(customGcodeProblem('M117 Change the plate\nG4 P1000')).toBeNull()
  })

  it('keeps one mark per height, sorted, and sends them by height', () => {
    addMark(0.6, 'pause')
    addMark(0.2, 'color_change')
    addMark(0.6, 'custom', 'M117 hi')
    const m = marksFor()
    expect(m.map((x) => `${x.z}:${x.kind}`)).toEqual(['0.2:color_change', '0.6:custom'])
    expect(layerGcodeByHeight(m)).toEqual([{ zMm: 0.2, kind: 'color_change' }, { zMm: 0.6, kind: 'custom', gcode: 'M117 hi' }])
    removeMark(m[0]!.id)
    expect(marksFor()).toHaveLength(1)
    expect(() => addMark(0.4, 'custom', 'M500')).toThrow('printer memory')
    expect(get().layerMarks['plate-1']).toHaveLength(1)
  })
})

describe('layer marks in a project file', () => {
  it('are written as Orca lays them out and read back, with custom text kept', async () => {
    const { writeProject, projectFiles } = await import('../src/export/threemf')
    const { readProject } = await import('../src/export/import3mf')
    const { boxMesh } = await import('../src/plate/mesh-ops')
    const { compose } = await import('../src/plate/transform')
    const entry: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [50, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
    const input = {
      plates: [{ id: 'p1', name: 'Plate 1', objects: [entry], settings: { sequence: 'by-layer' as const } }],
      bed: { widthMm: 256, depthMm: 256 },
      settings: {},
      layerMarks: { 0: [{ z: 2, kind: 'pause' as const }, { z: 4.2, kind: 'color_change' as const }, { z: 6, kind: 'custom' as const, gcode: 'M117 hi <there>' }] },
    }
    const xml = String(projectFiles(input).find((f) => f.name === 'Metadata/custom_gcode_per_layer.xml')!.data)
    expect(xml).toContain('<plate_info id="1"/>')
    expect(xml).toContain('top_z="2" type="1"')
    expect(xml).toContain('top_z="4.2" type="0"')
    expect(xml).toContain('top_z="6" type="4"')
    const read = await readProject(writeProject(input), input.bed)
    expect(read.plates[0]!.marks).toEqual([{ z: 2, kind: 'pause' }, { z: 4.2, kind: 'color_change' }, { z: 6, kind: 'custom', gcode: 'M117 hi <there>' }])
  })

  it('a project without marks has no marks file', async () => {
    const { projectFiles } = await import('../src/export/threemf')
    const files = projectFiles({ plates: [], bed: { widthMm: 256, depthMm: 256 }, settings: {} })
    expect(files.some((f) => f.name === 'Metadata/custom_gcode_per_layer.xml')).toBe(false)
  })
})
