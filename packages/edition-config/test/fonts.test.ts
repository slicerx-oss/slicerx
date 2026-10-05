// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition's brand fonts and logos: bundled from the files the config names, fonts never left on the browser's
// serif default, and a large logo shipped as a file instead of a data URL in the startup JS.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkEditionConfig, fontFaceCss, fontStack, missingFonts, parseEditionConfig } from '../src/index.ts'
import { editionAssetsPlugin, editionFontAssets, editionFontFiles, editionLogoAssets, INLINE_LOGO_BYTES } from '../src/node.ts'
import { logoImage } from '../src/links.ts'

const acme = JSON.parse(readFileSync(new URL('../fixtures/acme/acme.json', import.meta.url), 'utf8'))
const withTheme = (tokens: object) => ({ ...acme, brand: { ...acme.brand, theme: { base: 'nocturne', tokens } } })

describe('edition fonts', () => {
  it('a family name alone gets a sans-serif stack, never the serif default', () => {
    for (const v of ['Sora', 'Manrope', '"Space Grotesk"', 'Sora, Manrope']) {
      const s = fontStack(v, 'sans')
      expect(s).toMatch(/, sans-serif$/)
      expect(s).not.toMatch(/(^|,)\s*serif\b/)
    }
    expect(fontStack('Sora', 'sans').startsWith('"Sora", ')).toBe(true)
    expect(fontStack('JetBrains Mono', 'mono')).toMatch(/^"JetBrains Mono", .*monospace$/)
    // a stack that already ends in a generic family is left as written
    expect(fontStack('Inter, system-ui, sans-serif', 'sans')).toBe('"Inter", system-ui, sans-serif')
  })

  it('names the families nothing ships', () => {
    const c = parseEditionConfig(withTheme({ fonts: { display: 'Sora', body: 'Inter', mono: 'JetBrains Mono' } }))
    expect(missingFonts(c)).toEqual(['Sora'])
    const bundled = parseEditionConfig(withTheme({ fonts: { display: 'Sora' }, fontFiles: [{ family: 'Sora', src: 'fonts/sora.woff2', weight: '100 800' }] }))
    expect(missingFonts(bundled)).toEqual([])
  })

  it('refuses font files the browser cannot load', () => {
    const r = checkEditionConfig(withTheme({ fontFiles: [{ family: 'Sora', src: 'fonts/sora.svg' }] }))
    expect(r.ok).toBe(false)
    expect(checkEditionConfig(withTheme({ fontFiles: [{ family: 'So"ra', src: 'fonts/sora.woff2' }] })).ok).toBe(false)
  })

  it('bundles the files next to the config and writes their @font-face rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edition-fonts-'))
    mkdirSync(join(dir, 'fonts'))
    writeFileSync(join(dir, 'fonts', 'sora.woff2'), new Uint8Array([119, 79, 70, 50, 1, 2, 3]))
    const configFile = join(dir, 'edition.config.json')
    const c = parseEditionConfig(withTheme({ fonts: { display: 'Sora' }, fontFiles: [{ family: 'Sora', src: 'fonts/sora.woff2', weight: '100 800' }] }))
    const files = editionFontFiles(c, configFile)
    expect(files).toHaveLength(1)

    const { assets, css } = editionFontAssets(files, '/studio/')
    const plugin = editionAssetsPlugin(assets, css, '/studio/')
    const emitted: { fileName: string; source: Uint8Array }[] = []
    plugin.generateBundle.call({ emitFile: (f) => (emitted.push(f), f.fileName) })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.fileName).toMatch(/^static\/fonts\/[0-9a-f]{8}-sora\.woff2$/)
    const [tag] = plugin.transformIndexHtml()
    expect(tag!.tag).toBe('style')
    expect(tag!.children).toContain('font-family:"Sora"')
    expect(tag!.children).toContain(`url("/studio/${emitted[0]!.fileName}") format("woff2")`)
    expect(tag!.children).toContain('font-weight:100 800')

    // a missing file is a build error, not a silent fallback
    const missing = parseEditionConfig(withTheme({ fontFiles: [{ family: 'Manrope', src: 'fonts/manrope.woff2' }] }))
    expect(() => editionFontFiles(missing, configFile)).toThrow(/not found/)
  })

  it('writes nothing when the edition bundles no fonts', () => {
    expect(editionAssetsPlugin([], '', './').transformIndexHtml()).toEqual([])
    expect(fontFaceCss([])).toBe('')
  })
})

describe('edition logos in a build', () => {
  it('inlines a small mark and ships a large one as a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edition-logo-'))
    mkdirSync(join(dir, 'brand'))
    writeFileSync(join(dir, 'brand', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>')
    writeFileSync(join(dir, 'brand', 'wordmark.png'), new Uint8Array(INLINE_LOGO_BYTES + 1))
    const configFile = join(dir, 'edition.config.json')
    const c = parseEditionConfig({ ...acme, brand: { ...acme.brand, logo: { ...acme.brand.logo, mark: 'brand/mark.svg', wordmark: 'brand/wordmark.png' } } })

    const { config, assets } = editionLogoAssets(c, configFile, './')
    expect(logoImage(config, 'mark')).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(assets.map((a) => a.name)).toEqual([expect.stringMatching(/^static\/brand\/[0-9a-f]{8}-wordmark\.png$/)])
    expect(logoImage(config, 'wordmark')).toBe(`./${assets[0]!.name}`)
    expect(logoImage(editionLogoAssets(c, configFile, '/studio/').config, 'wordmark')).toMatch(/^\/studio\/static\/brand\//)
  })
})
