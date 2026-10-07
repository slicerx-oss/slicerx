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

  it('refuses with a message that says slicing still works', () => {
    expect(() => refuseVaultFile(project('f.sx3mf', '<metadata name="sx:Listing">id</metadata>'))).toThrow(/leaves SlicerX only as \.sx3mf/)
  })
})
