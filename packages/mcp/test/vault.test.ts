// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isVaultFile, refuseVaultFile } from '../src/vault'
import { writeZip } from '../src/zip'

const dir = mkdtempSync(join(tmpdir(), 'sx-vault-'))
function project(name: string, root: string, settings?: string): string {
  const path = join(dir, name)
  const entries = [{ name: '3D/3dmodel.model', data: `<?xml version="1.0"?><model unit="millimeter">${root}<resources/><build/></model>` }]
  if (settings) entries.push({ name: 'Metadata/model_settings.config', data: settings })
  writeFileSync(path, writeZip(entries))
  return path
}

describe('Vault designs in the mesh tools', () => {
  it('spots sx:Listing on the root model or on an object', () => {
    expect(isVaultFile(project('a.sx3mf', '<metadata name="sx:Listing">11111111-1111-4111-8111-111111111111</metadata>'))).toBe(true)
    expect(isVaultFile(project('b.3mf', '', '<config><object id="1"><metadata key="sx:Listing" value="abc"/></object></config>'))).toBe(true)
  })

  it('lets your own files through', () => {
    expect(isVaultFile(project('c.sx3mf', '<metadata name="sx:ExportedBy">x</metadata>'))).toBe(false)
    expect(isVaultFile(project('d.3mf', '<metadata name="sx:Listing"></metadata>'))).toBe(false)
    const stl = join(dir, 'e.stl')
    writeFileSync(stl, 'solid x\nendsolid x\n')
    expect(isVaultFile(stl)).toBe(false)
  })

  const ID = '11111111-1111-4111-8111-111111111111'
  const big = `<resources><object id="1" type="model"><mesh><vertices>${'<vertex x="1" y="2" z="3"/>'.repeat(50_000)}</vertices></mesh></object></resources>`
  const model = (inner: string, attrs = '') => `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${attrs}>${inner}<build/></model>`
  function raw(name: string, entries: { name: string; data: string }[]): string {
    const path = join(dir, name)
    writeFileSync(path, writeZip(entries))
    return path
  }

  it('reads the marks as XML: any quoting, attribute order, prefix or position', () => {
    const cases: [string, string, string?][] = [
      ['single quotes', model(`<metadata name='sx:Listing'>${ID}</metadata><resources/>`)],
      ['an attribute before name', model(`<metadata type="xs:string" preserve="1" name="sx:Listing">${ID}</metadata><resources/>`)],
      ['spaces around =', model(`<metadata name = "sx:Listing" >${ID}</metadata><resources/>`)],
      ['another prefix bound to the sx namespace', model(`<metadata name="v:Listing">${ID}</metadata><resources/>`, ' xmlns:v="https://slicerx.app/schemas/sx3mf/2026"')],
      ['a prefixed core element', `<?xml version="1.0"?><c:model xmlns:c="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><c:metadata name="sx:Listing">${ID}</c:metadata></c:model>`],
      ['an entity in the name', model(`<metadata name="sx:&#76;isting">${ID}</metadata><resources/>`)],
      ['CDATA', model(`<metadata name="sx:Listing"><![CDATA[${ID}]]></metadata><resources/>`)],
      ['a comment before it', model(`<!-- <metadata name="sx:Listing"></metadata> --><metadata name="sx:Listing">${ID}</metadata><resources/>`)],
      ['after 1 MB of mesh', model(`${big}<metadata name="sx:Listing">${ID}</metadata>`)],
    ]
    for (const [what, xml] of cases) {
      expect(xml.length > 1 << 20 || what !== 'after 1 MB of mesh').toBe(true)
      expect(isVaultFile(raw(`m-${what.replace(/\W+/g, '-')}.3mf`, [{ name: '3D/3dmodel.model', data: xml }])), what).toBe(true)
    }
    const settings: [string, string][] = [
      ['single quotes', `<config><object id='1'><metadata key='sx:Listing' value='${ID}'/></object></config>`],
      ['value before key', `<config><object id="1"><metadata value="${ID}" key="sx:Listing"/></object></config>`],
      ['an attribute before key', `<config><object id="1"><metadata note="x" key="sx:Listing" value="${ID}"></metadata></object></config>`],
      ['on a part', `<config><object id="1"><part id="2"><metadata key="sx:Listing" value="${ID}"/></part></object></config>`],
      ['after 1 MB', `<config>${'<object id="9"><metadata key="name" value="filler filler filler"/></object>'.repeat(20_000)}<object id="1"><metadata key="sx:Listing" value="${ID}"/></object></config>`],
    ]
    for (const [what, cfg] of settings) {
      const path = raw(`s-${what.replace(/\W+/g, '-')}.3mf`, [{ name: '3D/3dmodel.model', data: model('<resources/>') }, { name: 'Metadata/model_settings.config', data: cfg }])
      expect(isVaultFile(path), what).toBe(true)
    }
  })

  it('finds a mark in a split object file, and in a 3MF named like an STL', () => {
    expect(isVaultFile(raw('split.3mf', [{ name: '3D/3dmodel.model', data: model('<resources/>') }, { name: '3D/Objects/object_1.model', data: model(`<metadata name="sx:Listing">${ID}</metadata><resources/>`) }]))).toBe(true)
    expect(isVaultFile(raw('renamed.stl', [{ name: '3D/3dmodel.model', data: model(`<metadata name="sx:Listing">${ID}</metadata><resources/>`) }]))).toBe(true)
  })

  it('does not take other names, other prefixes or a mark in a comment for a listing', () => {
    expect(isVaultFile(raw('n1.3mf', [{ name: '3D/3dmodel.model', data: model(`<metadata name="sx:Version">1.0.0</metadata><metadata name="other:Listing">${ID}</metadata><!-- <metadata name="sx:Listing">${ID}</metadata> --><resources/>`) }]))).toBe(false)
  })

  it('refuses a part with a DTD, which could hide a mark behind an entity', () => {
    const path = raw('dtd.3mf', [{ name: '3D/3dmodel.model', data: `<?xml version="1.0"?><!DOCTYPE model [<!ENTITY l "Listing">]><model><metadata name="sx:&l;">${ID}</metadata></model>` }])
    expect(isVaultFile(path)).toBe(true)
    expect(() => refuseVaultFile(path)).toThrow(/could not be checked for a Vault listing: .*DTD/)
  })

  it('refuses with a message that says slicing still works', () => {
    expect(() => refuseVaultFile(project('f.sx3mf', '<metadata name="sx:Listing">id</metadata>'))).toThrow(/leaves SlicerX only as \.sx3mf/)
  })
})
