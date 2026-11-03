// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A .gcode.3mf that slicerx_slice_file writes for a Vault design, the way a client asks for one: the layout the app
// writes for a Vault design's print file (checked on the A1 and A1 mini), so no mesh leaves in it and it still names
// its listing. A file of your own slices as before.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { md5Hex } from '@slicerx/threemf'
import { describe, expect, it } from 'vitest'
import { gcode3mf } from '../src/gcode3mf'
import { createContext, createSlicerxServer } from '../src/index'
import type { SliceJob, SliceSummary, SlicerBackend } from '../src/slicer'
import { isVaultFile } from '../src/vault'
import { readZip, writeZip } from '../src/zip'
import { connect, data, text } from './helpers'

const LISTING = '00000000-0000-4000-8000-0000000c11b0'
const CREATOR = '00000000-0000-4000-8000-00000000c0de'
const LAYOUT = [
  '[Content_Types].xml',
  '_rels/.rels',
  '3D/3dmodel.model',
  'Metadata/model_settings.config',
  'Metadata/project_settings.config',
  'Metadata/slice_info.config',
  'Metadata/plate_1.gcode',
  'Metadata/plate_1.gcode.md5',
  'Metadata/plate_1.json',
  'Metadata/_rels/model_settings.config.rels',
]
const GCODE = '; HEADER_BLOCK_START\n; model label id: 1,2\n; HEADER_BLOCK_END\n; start printing object, unique label id: 1\nG1 X96 Y126\nG1 X116 Y134 E1\n; stop printing object, unique label id: 1\n; start printing object, unique label id: 2\nG1 X140 Y126\nG1 X160 Y134 E1\n; stop printing object, unique label id: 2\n; total filament used [g] = 2.21\n; estimated printing time (normal mode) = 14m 15s\n'

const TETRA = '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh></object>'
/** A one-object .sx3mf: a Vault design (with the marks the library stamps) or your own. */
function design(dir: string, name: string, vault: boolean): string {
  const marks = vault ? `<metadata name="sx:Listing">${LISTING}</metadata><metadata name="sx:Creator">${CREATOR}</metadata>` : ''
  const path = join(dir, name)
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:sx="https://slicerx.app/schemas/sx3mf/2026">${marks}<resources>${TETRA}</resources><build><item objectid="1"/></build></model>` }]))
  return path
}

/** Stands in for the sx engine: writes a two-object plate's G-code, whatever the model. */
function fakeSx(): SlicerBackend {
  return {
    kind: 'sx',
    async slice(job: SliceJob): Promise<SliceSummary> {
      mkdirSync(job.outDir, { recursive: true })
      const gcodePath = join(job.outDir, 'plate.gcode')
      writeFileSync(gcodePath, GCODE)
      return { engine: 'sx', model: { name: 'Cable clip' }, layer_count: 45, time_s: 855, time_text: '14m 15s', filament_g: 2.21, filament_mm: 730, filaments: [], warnings: [], gcode_path: gcodePath }
    },
  }
}

/** A client on a server whose engine is the stand-in. */
async function client() {
  const h = await connect()
  const ctx = await createContext({ engine: 'stub', allowDirs: [h.dir], outDir: join(h.dir, 'out'), profilesDir: join(h.dir, 'profiles'), policy: DEFAULT_POLICY })
  const server = createSlicerxServer({ ...ctx, slicer: fakeSx() })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), c.connect(b)])
  return { dir: h.dir, call: async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as CallToolResult }
}

describe('slicerx_slice_file to a .gcode.3mf for a Vault design', () => {
  it('writes no mesh, keeps the G-code and its MD5, the objects to skip and the listing', async () => {
    const c = await client()
    const r = await c.call('slicerx_slice_file', { model: design(c.dir, 'clip.sx3mf', true), output: 'gcode.3mf' })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ gcode_3mf_path: string }>(r).gcode_3mf_path
    const zip = readZip(readFileSync(out))
    expect(zip.names()).toEqual(LAYOUT)
    expect(zip.text('Metadata/plate_1.gcode')).toBe(GCODE)
    expect(zip.text('Metadata/plate_1.gcode.md5')).toBe(md5Hex(new TextEncoder().encode(GCODE)).toUpperCase())
    const model = zip.text('3D/3dmodel.model') ?? ''
    expect(model).toContain('<metadata name="Title">Cable clip</metadata>')
    expect(model).toContain(`<metadata name="sx:Listing">${LISTING}</metadata><metadata name="sx:Creator">${CREATOR}</metadata><metadata name="sx:ExportedBy"></metadata><resources></resources><build></build></model>`)
    expect(model).not.toMatch(/<object|<vertex|<item/)
    expect(zip.text('Metadata/model_settings.config')).not.toMatch(/<object|model_instance/)
    const info = zip.text('Metadata/slice_info.config') ?? ''
    expect(info).toContain('<object identify_id="1" name="Cable clip" skipped="false" />')
    expect(info).toContain('<object identify_id="2" name="Cable clip 2" skipped="false" />')
    // It reads as a Vault design again, so the mesh tools refuse it too.
    expect(isVaultFile(out)).toBe(true)
  })

  it('takes the listing from an object when the root names none', async () => {
    const c = await client()
    const path = join(c.dir, 'marked-object.3mf')
    writeFileSync(path, writeZip([
      { name: '3D/3dmodel.model', data: `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${TETRA}</resources><build><item objectid="1"/></build></model>` },
      { name: 'Metadata/model_settings.config', data: `<config><object id="1"><metadata key="sx:Listing" value="${LISTING}"/></object></config>` },
    ]))
    const r = await c.call('slicerx_slice_file', { model: path, output: 'gcode.3mf' })
    expect(r.isError, text(r)).toBeFalsy()
    const model = readZip(readFileSync(data<{ gcode_3mf_path: string }>(r).gcode_3mf_path)).text('3D/3dmodel.model') ?? ''
    expect(model).toContain(`<metadata name="sx:Listing">${LISTING}</metadata><metadata name="sx:ExportedBy"></metadata>`)
  })

  it('leaves the .gcode.3mf of your own design as it was', async () => {
    const c = await client()
    const r = await c.call('slicerx_slice_file', { model: design(c.dir, 'mine.sx3mf', false), output: 'gcode.3mf' })
    expect(r.isError, text(r)).toBeFalsy()
    const bytes = readFileSync(data<{ gcode_3mf_path: string }>(r).gcode_3mf_path)
    const summary: SliceSummary = { engine: 'sx', model: { name: 'Cable clip' }, layer_count: 45, time_s: 855, time_text: '14m 15s', filament_g: 2.21, filament_mm: 730, filaments: [], warnings: [] }
    const zip = readZip(bytes)
    expect(zip.text('3D/3dmodel.model')).not.toContain('sx:')
    expect(zip.text('3D/3dmodel.model')).toContain('<metadata name="Title">Project</metadata>')
    expect(zip.names()).toEqual(LAYOUT)
    // Without a Vault mark the writer gives the same bytes as before.
    expect(gcode3mf(GCODE, summary, {}).equals(gcode3mf(GCODE, summary, {}, null))).toBe(true)
  })
})
