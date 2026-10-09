// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { ModelScanError, parseNumber, scanModelBytes } from '../src/export/model-scan'
import { scanProject } from '../src/export/project-scan'
import { zip, zipCompressed } from '../src/export/zip'

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s)

describe('the model part scanner', () => {
  it('parses numbers exactly as Number() does', () => {
    const cases = ['0', '-0', '1', '-1.5', '+2.25', '12.345678', '0.000123', '.5', '5.', '100', '1e3', '-2.5E-2', '123456789.123456789', '3.4028235e39', ' 7', '', 'abc', '1.2.3', '0.1', '0.30000000000000004', '9007199254740993']
    for (const c of cases) {
      const b = bytes(c)
      expect(Object.is(parseNumber(b, 0, b.length), Number(c)), c).toBe(true)
    }
    // Random decimals as slicers write them.
    let seed = 1
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0
      const c = ((seed / 2 ** 32 - 0.5) * 10 ** ((seed % 7) - 2)).toFixed(seed % 9)
      const b = bytes(c)
      expect(parseNumber(b, 0, b.length), c).toBe(Number(c))
    }
  })

  it('reads objects, meshes, components and build items in any attribute order or quoting', () => {
    const xml = `<?xml version="1.0"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <metadata name="Title">Two</metadata>
 <resources>
  <object id="1" name="A &amp; B" type="model">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/>
     <vertex z='3' x='1.5' y="2"/>
     <vertex y="1" x="-1" z="0.25" />
    </vertices>
    <triangles>
     <triangle v1="0" v2="1" v3="2" paint_color="4"/>
     <triangle v3="0" v1="2" v2="1"/>
    </triangles>
   </mesh>
  </object>
  <object id="2" type="model"><components><component p:path="/3D/Objects/o.model" objectid="7" transform="1 0 0 0 1 0 0 0 1 5 6 7"/></components></object>
  <object id="3"/>
 </resources>
 <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 0" printable="0"/><item objectid="2"/></build>
</model>`
    const m = scanModelBytes(bytes(xml))
    const a = m.objects.get('1')!
    expect(a.name).toBe('A & B')
    expect([...a.mesh!.positions]).toEqual([0, 0, 0, 1.5, 2, 3, -1, 1, 0.25])
    expect([...a.mesh!.indices]).toEqual([0, 1, 2, 2, 1, 0])
    expect(a.mesh!.paint).toEqual({ color: { 0: '4' } })
    expect(m.objects.get('2')).toEqual({ mesh: null, components: [{ path: '/3D/Objects/o.model', objectId: '7', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] }] })
    expect(m.objects.get('3')).toEqual({ mesh: null, components: [] })
    expect(m.items).toEqual([
      { objectId: '1', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1], printable: false },
      { objectId: '2', transform: null, printable: true },
    ])
  })

  it('refuses a vertex that is not a number and a triangle off its vertices', () => {
    const mesh = (v: string, t: string) => bytes(`<model><resources><object id="1"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object></resources></model>`)
    const three = '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>'
    expect(() => scanModelBytes(mesh('<vertex x="0" y="0"/>', ''))).toThrow(ModelScanError)
    expect(() => scanModelBytes(mesh('<vertex x="nan" y="0" z="0"/>', ''))).toThrow('not a number')
    expect(() => scanModelBytes(mesh(three, '<triangle v1="0" v2="1" v3="3"/>'))).toThrow('outside its vertices')
    expect(() => scanModelBytes(mesh(three, '<triangle v1="0" v2="-1" v3="2"/>'))).toThrow('outside its vertices')
    expect(scanModelBytes(mesh(three, '<triangle v1="0" v2="1" v3="2"/>')).objects.get('1')!.mesh!.indices.length).toBe(3)
  })

  it('leaves the vertex and triangle runs out of the skeleton and keeps the rest', () => {
    const xml = '<!DOCTYPE x><model><metadata name="sx:Listing">L1</metadata><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><!-- note --><vertex x="1" y="0" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="1"/></triangles></mesh></object></resources></model>'
    let skeleton = ''
    scanModelBytes(bytes(xml), (s) => (skeleton = new TextDecoder().decode(s)))
    expect(skeleton).toContain('<!DOCTYPE x>')
    expect(skeleton).toContain('<metadata name="sx:Listing">L1</metadata>')
    expect(skeleton).toContain('<!-- note -->')
    expect(skeleton).not.toContain('<vertex ')
    expect(skeleton).not.toContain('<triangle ')
    expect(skeleton).toContain('</vertices><triangles></triangles>')
  })
})

describe('the project scan', () => {
  const model = (listing: string) =>
    `<model xmlns:sx="https://slicerx.app/schemas/sx3mf/2026"><metadata name="sx:Listing">${listing}</metadata><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`

  it('scans the model parts and keeps the other entries as they are', async () => {
    const archive = zip([
      { name: '3D/3dmodel.model', data: model('L1') },
      { name: 'Metadata/project_settings.config', data: '{}' },
    ])
    const p = await scanProject(archive)
    expect([...p.files.keys()]).toEqual(['Metadata/project_settings.config'])
    const main = p.models.get('3D/3dmodel.model')
    expect(main && !('error' in main) && main.objects.get('1')?.mesh?.indices.length).toBe(3)
    expect(p.marks).toEqual({ listing: 'L1' })
  })

  it('keeps a part that does not scan as an error for whoever uses it, and refuses a DTD anywhere', async () => {
    const broken = await scanProject(await zipCompressed([
      { name: '3D/3dmodel.model', data: model('L1') },
      { name: '3D/Objects/unused.model', data: '<model><resources><object id="1"><mesh><vertices><vertex x="a" y="0" z="0"/></vertices><triangles/></mesh></object></resources></model>' },
    ]))
    expect(broken.models.get('3D/Objects/unused.model')).toEqual({ error: 'The 3MF model has a vertex that is not a number.' })
    const dtd = await scanProject(zip([{ name: '3D/3dmodel.model', data: `<!DOCTYPE model>${model('L1')}` }]))
    expect(dtd.markError).toMatch(/DTD/)
  })
})
