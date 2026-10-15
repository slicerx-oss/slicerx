// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { viteDefines } from '../src/build.ts'
import { defineEditionConfig } from '../src/define.ts'
import { editionLogoAssets, inlineLogo, INLINE_LOGO_BYTES } from '../src/node.ts'

describe('edition assistant identity', () => {
  it('keeps the built-in identity when an existing edition omits it', () => {
    expect(defineEditionConfig({}).brand.assistant).toEqual({ name: 'mimir', icon: 'builtin:mimir' })
  })

  it('accepts an edition name, bundled icon and separate theme accents', () => {
    const assistant = { name: 'YourMate', icon: 'brand/assistant.svg', accent: { light: '#006b65', dark: '#63e6d4' } }
    expect(defineEditionConfig({ brand: { assistant } }).brand.assistant).toEqual(assistant)
    expect(defineEditionConfig({ brand: { assistant: { name: 'yourmate' } } }).brand.assistant.name).toBe('yourmate')
  })

  it('defines the assistant identity without copying the full edition into its runtime', () => {
    const config = defineEditionConfig({ brand: { name: 'Other Product', assistant: { name: 'YourMate', icon: 'helper.svg' } } })
    const value = viteDefines(config)['__SX_ASSISTANT_BRAND__']!
    expect(JSON.parse(value)).toEqual(config.brand.assistant)
    expect(value).not.toContain('Other Product')
    expect(JSON.parse(viteDefines(defineEditionConfig({}))['__SX_ASSISTANT_BRAND__']!)).toEqual({ name: 'mimir', icon: 'builtin:mimir' })
  })

  it('applies the lowercase rule only to mimir', () => {
    expect(defineEditionConfig({ brand: { assistant: { name: ' MIMIR ' } } }).brand.assistant.name).toBe('mimir')
    expect(defineEditionConfig({ brand: { assistant: { name: 'Print Helper' } } }).brand.assistant.name).toBe('Print Helper')
  })

  it('rejects empty names, control characters, executable URLs and invalid colors', () => {
    for (const assistant of [{ name: ' ' }, { name: 'a\nb' }, { icon: 'javascript:alert(1)' }, { accent: 'red' }, { accent: { light: '#ffffff', dark: 'bad' } }]) {
      expect(() => defineEditionConfig({ brand: { assistant } })).toThrow()
    }
  })

  it('bundles the assistant icon relative to its edition, including large files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'assistant-brand-'))
    try {
      const configFile = join(dir, 'edition.json')
      writeFileSync(join(dir, 'helper.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>')
      const config = defineEditionConfig({ brand: { assistant: { name: 'yourmate', icon: 'helper.svg' } } })
      expect(inlineLogo(config, configFile).brand.assistant.icon).toMatch(/^data:image\/svg\+xml;base64,/)
      expect(editionLogoAssets(config, configFile, './').config.brand.assistant.icon).toMatch(/^data:image\/svg\+xml;base64,/)
      writeFileSync(join(dir, 'helper.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(INLINE_LOGO_BYTES)}--></svg>`)
      const built = editionLogoAssets(config, configFile, '/studio/')
      expect(built.assets).toHaveLength(1)
      expect(built.config.brand.assistant.icon).toBe(`/studio/${built.assets[0]!.name}`)
      expect(() => editionLogoAssets(defineEditionConfig({ brand: { assistant: { icon: 'missing.svg' } } }), configFile, './')).toThrow(/brand.assistant.icon not found/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
