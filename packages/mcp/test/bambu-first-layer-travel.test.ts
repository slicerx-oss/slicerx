// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client that reads a project through the MCP gets the app's reading of a missing first layer travel acceleration:
// Bambu Studio's 500 mm/s2 for a project it wrote, the project's own value when it has one, nothing for other apps.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`
const dir = mkdtempSync(join(tmpdir(), 'sx-first-layer-travel-'))
let n = 0
function project(app: string | undefined, settings: Record<string, unknown>): string {
  const path = join(dir, `p${n++}.3mf`)
  const model = app ? MODEL.replace('<resources>', `<metadata name="Application">${app}</metadata><resources>`) : MODEL
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/project_settings.config', data: JSON.stringify({ layer_height: '0.2', ...settings }) }]))
  return path
}
const travel = (app: string | undefined, settings: Record<string, unknown> = {}) => {
  const r = readProjectFile(project(app, settings))
  return { value: r.config['initial_layer_travel_acceleration'], unknown: r.summary.unknown_keys }
}

describe('first layer travel acceleration of a project without the key', () => {
  it('is 500 for a Bambu Studio project, and 500 is a key SlicerX knows', () => {
    const r = travel('BambuStudio-01.10.02.73')
    expect(r.value).toBeDefined()
    expect(Number(Array.isArray(r.value) ? r.value[0] : r.value)).toBe(500)
    expect(r.unknown).toEqual([])
  })

  it("is the project's own value when it has one", () => {
    const r = travel('BambuStudio-01.10.02.73', { initial_layer_travel_acceleration: ['6000'] })
    expect(Number(Array.isArray(r.value) ? r.value[0] : r.value)).toBe(6000)
  })

  it('is not set for an OrcaSlicer project or one with no app named', () => {
    expect(travel('OrcaSlicer-2.3.0').value).toBeUndefined()
    expect(travel(undefined).value).toBeUndefined()
  })
})
