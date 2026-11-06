// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project part of a type no slicer writes prints as a normal part (the engine reads it as one), so its filament is
// one of the project's filaments, as a model part's is. Modifiers, negative parts and support painters still print
// no filament of their own.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'

const box = '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh>'
const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model">${box}</object><object id="2" type="model">${box}</object><object id="3" type="model"><components><component objectid="1"/><component objectid="2" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></components></object></resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`

const dir = mkdtempSync(join(tmpdir(), 'unknown-part-slot-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The bracket with its second part of `subtype` on filament 2. */
function project(subtype: string): string {
  const path = join(dir, `${subtype}.3mf`)
  const settings = `<?xml version="1.0"?><config><object id="3"><metadata key="name" value="Bracket"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="Body"/></part><part id="2" subtype="${subtype}"><metadata key="name" value="Gear"/><metadata key="extruder" value="2"/></part></object></config>`
  writeFileSync(path, writeZip([
    { name: '3D/3dmodel.model', data: MODEL },
    { name: 'Metadata/model_settings.config', data: settings },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ layer_height: '0.2', filament_type: ['PLA', 'PLA'] }) },
  ]))
  return path
}

describe('the filaments a project part of an unknown type prints with', () => {
  it('counts its filament, as the engine prints it as a normal part', () => {
    expect(readProjectFile(project('lattice_part')).opened?.used).toEqual([1, 2])
  })

  it('still leaves out the filament of a part that prints none', () => {
    expect(readProjectFile(project('modifier_part')).opened?.used).toEqual([1])
    expect(readProjectFile(project('NegativeVolume')).opened?.used).toEqual([1])
    expect(readProjectFile(project('normal_part')).opened?.used).toEqual([1, 2])
  })
})
