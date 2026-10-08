// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MONO_FONTS, UI_FONTS, resolveFonts } from '../src/fonts'
import { FONT_IDS } from '../src/fonts-ids'
import { nocturne, subban } from '../src/theme'
import { BUNDLED_THEMES } from '../src/theme-bundle'
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, DEFAULT_THEMES, DEFAULT_THEME_IDS, LEGACY_THEME_IDS, allThemes, familyId, findTheme, migrateThemeId, pickFamily, pickTheme, slugify, themeFamilies, themeForScheme } from '../src/theme-library'
import { nocturneLight, subbanLight } from '../src/themes'
import { SCENE } from '../viewport/src/palette'
import { GLYPH_CONTRAST, HIGH_TEXT_CONTRAST, TEXT_CONTRAST, contrast, derivePalette, deriveScene, mixHex, parseHex, parseThemeText, readable, rehue, serializeTheme, themeColors, themeFromFile, validateThemeFile, type ThemeFile } from '../src/themefile'

const here = resolve(import.meta.dirname, '../themes')
const slicerxDark = BUNDLED_THEMES.find((t) => t.id === 'subban-dark') as ThemeFile
const slicerxLight = BUNDLED_THEMES.find((t) => t.id === 'subban-light') as ThemeFile

const good = () => JSON.parse(JSON.stringify(slicerxDark)) as Record<string, unknown>

describe('hex math', () => {
  it('parses and rejects', () => {
    expect(parseHex('#ff8000')).toEqual({ r: 1, g: 128 / 255, b: 0 })
    expect(parseHex('#ff800080')).not.toBeNull()
    expect(parseHex('ff8000')).toBeNull()
    expect(parseHex('#fff')).toBeNull()
  })
  it('mixes a fraction of the way', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#102030', '#102030', 0.7)).toBe('#102030')
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
  })
  it('measures WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5)
  })
  it('readable lifts toward the text in 5% steps and leaves good colors alone', () => {
    const ground = ['#282a36']
    expect(readable('#f8f8f2', ground, '#f8f8f2', 4.5)).toBe('#f8f8f2')
    const lifted = readable('#44475a', ground, '#f8f8f2', 4.5)
    expect(contrast(lifted, '#282a36')).toBeGreaterThanOrEqual(4.5)
    expect(lifted).not.toBe('#44475a')
    // It never overshoots by more than one step.
    expect(contrast(mixHex('#44475a', '#f8f8f2', 0.05), '#282a36')).toBeLessThan(4.5)
  })
  it('rehue keeps brightness and sets hue and a minimum saturation', () => {
    expect(rehue('#f1fa8c', 30, 0.55)).toBe('#fab570')
    expect(rehue('#808080', 0, 0)).toBe('#808080')
  })
})

describe('derived palette follows the documented rules', () => {
  it('derives Subban dark', () => {
    const p = derivePalette(slicerxDark)
    expect(p.pane).toBe(mixHex('#282a36', '#2f3241', 0.5))
    expect(p.hairline).toBe(mixHex('#282a36', '#44475a', 0.7))
    expect(p.chip).toBe(mixHex('#282a36', '#44475a', 0.62))
    expect(p.chipStrong).toBe(mixHex('#2f3241', '#44475a', 0.6))
    expect(p.accent).toBe('#bd93f9')
    expect(p.orange).toBe('#fab570')
    expect(p.onAccent).toBe(mixHex('#282a36', '#000000', 0.25))
  })
  it('uses the status overrides when a theme sets them', () => {
    const p = derivePalette(slicerxLight)
    expect(p.orange).toBe('#9a5a16')
    expect(p.red).toBe('#c33c3c')
    expect(p.green).toBe('#168452')
    expect(p.onAccent).toBe('#ffffff')
  })
  it('deepens a pale accent on a light theme to 3:1', () => {
    const t: ThemeFile = { ...slicerxLight, accent: '#c9b6f5' }
    const p = derivePalette(t)
    expect(p.accent).not.toBe('#c9b6f5')
    expect(contrast(p.accent, t.background)).toBeGreaterThanOrEqual(GLYPH_CONTRAST)
    expect(contrast(p.accent, t.surface)).toBeGreaterThanOrEqual(GLYPH_CONTRAST)
  })
  it('keeps a dark theme accent as written', () => {
    expect(derivePalette({ ...slicerxDark, accent: '#5555aa' }).accent).toBe('#5555aa')
  })
  it('meets the contrast floor in every bundled theme', () => {
    for (const t of BUNDLED_THEMES) {
      const p = derivePalette(t)
      for (const ground of [t.background, t.surface]) {
        expect(contrast(p.text, ground), `${t.id} text on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST)
        expect(contrast(p.secondary, ground), `${t.id} secondary on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST)
        expect(contrast(p.dim, ground), `${t.id} dim on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST)
        for (const k of ['red', 'green', 'orange', 'yellow', 'blue', 'magenta', 'cyan'] as const) expect(contrast(p[k], ground), `${t.id} ${k} on ${ground}`).toBeGreaterThanOrEqual(GLYPH_CONTRAST)
      }
    }
  })
  it('survives a theme with terrible contrast by lifting the derived shades', () => {
    const t: ThemeFile = { ...slicerxDark, muted: '#303040', ansi: slicerxDark.ansi.map(() => '#2a2c38') }
    const p = derivePalette(t)
    expect(contrast(p.secondary, t.surface)).toBeGreaterThanOrEqual(TEXT_CONTRAST)
    expect(contrast(p.red, t.surface)).toBeGreaterThanOrEqual(GLYPH_CONTRAST)
  })
})

describe('maps onto the app theme', () => {
  it('the built-in Subban themes equal the Subban files, and the Nocturne names still reach them', () => {
    expect(subban.colors).toEqual(themeColors(slicerxDark))
    expect(subbanLight.colors).toEqual(themeColors(slicerxLight))
    expect(nocturne).toBe(subban)
    expect(nocturneLight).toBe(subbanLight)
  })
  it('sets the scheme and uses the id as the theme name', () => {
    expect(themeFromFile(slicerxLight).scheme).toBe('light')
    expect(themeFromFile(slicerxDark).name).toBe('subban-dark')
  })
  it('the person font choice beats the theme suggestion, which beats the default', () => {
    const suggested = { ...slicerxDark, fonts: { ui: 'inter', mono: 'ibm-plex-mono' } }
    const css = (list: readonly { id: string; css: string }[], id: string) => list.find((f) => f.id === id)?.css
    expect(themeFromFile(suggested).fonts.body).toBe(css(UI_FONTS, 'inter'))
    expect(themeFromFile(suggested, { ui: 'ibm-plex-sans', mono: 'theme' }).fonts.body).toBe(css(UI_FONTS, 'ibm-plex-sans'))
    expect(themeFromFile(suggested, { ui: 'ibm-plex-sans', mono: 'theme' }).fonts.mono).toBe(css(MONO_FONTS, 'ibm-plex-mono'))
    expect(themeFromFile(slicerxDark).fonts.body).toBe(css(UI_FONTS, 'hanken-grotesk'))
    expect(resolveFonts({ ui: 'nope', mono: 'nope' }).body).toBe(css(UI_FONTS, 'hanken-grotesk'))
    expect(resolveFonts({ ui: 'system', mono: 'system' }).display).toBe(css(UI_FONTS, 'system'))
  })
  it('the font lists match the ids the schema allows', () => {
    expect(UI_FONTS.map((f) => f.id)).toEqual([...FONT_IDS.ui])
    expect(MONO_FONTS.map((f) => f.id)).toEqual([...FONT_IDS.mono])
  })
})

describe('scene', () => {
  it('Subban dark derives the default dark studio exactly', () => {
    const sc = deriveScene(slicerxDark)
    expect(sc.top).toBe(SCENE.bgTop)
    expect(sc.bottom).toBe(SCENE.bgBottom)
    expect(sc.glow).toBe(SCENE.bgGlow)
    expect(sc.plate).toBe(SCENE.plateSide)
    expect(sc.grid).toBe(SCENE.floorGrid)
    expect(sc.edge).toBe(SCENE.edgeDark)
    expect(sc.xray).toBeUndefined()
  })
  it('a light theme gets a light studio with darker grid and edges', () => {
    const sc = deriveScene(slicerxLight)
    expect(contrast(sc.top, '#000000')).toBeGreaterThan(contrast(sc.top, '#ffffff'))
    expect(contrast(sc.grid, sc.bottom)).toBeGreaterThan(1.5)
    expect(contrast(sc.edge, sc.top)).toBeGreaterThan(7)
    expect(sc.xray).toBeDefined()
  })
  it('keys in the file win over derived ones', () => {
    expect(deriveScene({ ...slicerxDark, scene: { top: '#112233' } }).top).toBe('#112233')
    expect(deriveScene({ ...slicerxDark, scene: { top: '#112233' } }).bottom).toBe(SCENE.bgBottom)
  })
  it('validates the scene block', () => {
    expect(validateThemeFile({ ...good(), scene: { top: '#112233' } }).ok).toBe(true)
    const bad = validateThemeFile({ ...good(), scene: { top: 'blue', grid: '#12' } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/scene\.top, scene\.grid/)
    expect(validateThemeFile({ ...good(), scene: 'dark' }).ok).toBe(false)
  })
  it('every bundled theme file spells out its scene, matching the derivation', () => {
    for (const t of BUNDLED_THEMES) {
      expect(t.scene, t.id).toBeDefined()
      expect(deriveScene({ ...t, scene: {} }), t.id).toMatchObject(t.scene as object)
    }
  })
  it('reaches the app theme', () => {
    expect(themeFromFile(slicerxLight).scene).toEqual(deriveScene(slicerxLight))
  })
})

describe('validation', () => {
  it('accepts a bundled file and keeps its values', () => {
    const r = validateThemeFile(good())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theme).toEqual(slicerxDark)
  })
  it('rejects non-objects', () => {
    for (const v of [null, 3, 'x', [], undefined]) expect(validateThemeFile(v).ok).toBe(false)
  })
  const bad: [string, (o: Record<string, unknown>) => void, RegExp][] = [
    ['wrong version', (o) => (o['version'] = 2), /version/],
    ['bad id', (o) => (o['id'] = 'Not A Slug'), /id must/],
    ['empty name', (o) => (o['name'] = ' '), /name/],
    ['long name', (o) => (o['name'] = 'x'.repeat(41)), /name/],
    ['isDark text', (o) => (o['isDark'] = 'yes'), /isDark/],
    ['bad color', (o) => (o['accent'] = 'purple'), /accent/],
    ['short hex', (o) => (o['border'] = '#fff'), /border/],
    ['missing color', (o) => delete o['surface'], /surface/],
    ['bad optional color', (o) => (o['working'] = '#12'), /working/],
    ['ansi too short', (o) => (o['ansi'] = ['#000000']), /ansi/],
    ['ansi bad entry', (o) => ((o['ansi'] as string[])[3] = 'red'), /ansi/],
    ['unknown font', (o) => (o['fonts'] = { ui: 'comic-sans' }), /fonts\.ui/],
    ['fonts not an object', (o) => (o['fonts'] = 'inter'), /fonts/],
    ['long credit', (o) => (o['credit'] = 'x'.repeat(201)), /credit/],
  ]
  for (const [name, mutate, expected] of bad) {
    it(`rejects ${name}`, () => {
      const o = good()
      mutate(o)
      const r = validateThemeFile(o)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.join(' ')).toMatch(expected)
    })
  }
  it('reports every problem at once', () => {
    const o = good()
    o['id'] = 'BAD'
    o['accent'] = 'x'
    const r = validateThemeFile(o)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2)
  })
  it('warns about a wrong isDark flag and unreadable text, and still accepts', () => {
    const wrongFlag = validateThemeFile({ ...good(), isDark: false })
    expect(wrongFlag.ok && wrongFlag.warnings.some((w) => /isDark/.test(w))).toBe(true)
    const dim = validateThemeFile({ ...good(), text: '#3a3c4a' })
    expect(dim.ok && dim.warnings.some((w) => /below 4.5/.test(w))).toBe(true)
  })
  it('ignores unknown keys', () => {
    const r = validateThemeFile({ ...good(), extra: 1, $schema: './schema.json' })
    expect(r.ok).toBe(true)
    if (r.ok) expect('extra' in r.theme).toBe(false)
  })
  it('parseThemeText handles bad JSON and oversized text', () => {
    expect(parseThemeText('{nope')).toEqual({ ok: false, errors: ['This is not valid JSON.'] })
    const big = parseThemeText(' '.repeat(17 * 1024))
    expect(big.ok).toBe(false)
    expect(parseThemeText(serializeTheme(slicerxLight)).ok).toBe(true)
  })
  it('serializes with the schema line first and round-trips', () => {
    const text = serializeTheme(slicerxLight)
    expect(text.split('\n')[1]).toContain('$schema')
    const r = parseThemeText(text)
    expect(r.ok && r.theme).toEqual(slicerxLight)
  })
})

describe('the bundled files', () => {
  it('has the thirteen themes in light and dark, Subban first', () => {
    expect(BUNDLED_THEMES.map((t) => t.id)).toEqual([
      'subban-dark', 'subban-light', 'dracula', 'alucard', 'catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe', 'catppuccin-latte', 'nord', 'nord-light', 'atom-one-dark', 'one-light',
      'tokyo-night', 'tokyo-night-day', 'github-dark', 'github-light', 'solarized-dark', 'solarized-light', 'night', 'night-light', 'gothic', 'gothic-dark', 'newsprint', 'newsprint-dark', 'pixyll', 'pixyll-dark', 'whitey', 'whitey-dark',
    ])
    expect(DEFAULT_DARK_THEME).toBe('subban-dark')
    expect(DEFAULT_LIGHT_THEME).toBe('subban-light')
    const families = themeFamilies(BUNDLED_THEMES)
    expect(families.map((f) => f.name)).toEqual(['Subban', 'Dracula', 'Catppuccin', 'Nord', 'One', 'Tokyo Night', 'GitHub', 'Solarized', 'Night', 'Gothic', 'Newsprint', 'Pixyll', 'Whitey'])
    for (const f of families) {
      expect(f.light.length, f.id).toBe(1)
      expect(f.dark.length, f.id).toBeGreaterThanOrEqual(1)
    }
    expect(families.find((f) => f.id === 'catppuccin')?.dark.map((t) => t.flavor)).toEqual(['Mocha', 'Macchiato', 'Frappe'])
    expect(families.find((f) => f.id === 'catppuccin')?.light[0]?.flavor).toBe('Latte')
  })
  it('Subban light is the Nocturne Bright palette', () => {
    expect(slicerxLight).toMatchObject({ background: '#fbf8ff', text: '#2d2834', accent: '#7542bd', isDark: false, family: 'subban' })
    expect(slicerxLight.ansi.slice(1, 7)).toEqual(['#c33c3c', '#168452', '#8a6a00', '#276fa9', '#b3316d', '#008494'])
    expect(slicerxLight.waiting).toBe('#9a5a16')
  })
  it('every file on disk is valid, named after its id, and listed', () => {
    const files = readdirSync(here).filter((f) => f.endsWith('.json') && f !== 'schema.json')
    expect(files.sort()).toEqual(BUNDLED_THEMES.map((t) => `${t.id}.json`).sort())
    for (const f of files) {
      const r = parseThemeText(readFileSync(resolve(here, f), 'utf8'))
      expect(r.ok, f).toBe(true)
      if (r.ok) {
        expect(`${r.theme.id}.json`).toBe(f)
        expect(r.warnings, f).toEqual([])
      }
    }
  })
  it('keeps the Dracula license text with the palettes', () => {
    expect(readFileSync(resolve(here, 'LICENSES.md'), 'utf8')).toMatch(/Dracula Theme/)
  })
  it('the JSON Schema agrees with the validator', () => {
    const schema = JSON.parse(readFileSync(resolve(here, 'schema.json'), 'utf8')) as { required: string[]; properties: Record<string, { enum?: string[]; properties?: Record<string, { enum: string[] }> }> }
    expect(schema.required.sort()).toEqual(['version', 'id', 'name', 'isDark', 'background', 'surface', 'surfaceAlt', 'border', 'text', 'muted', 'accent', 'ansi'].sort())
    expect(schema.properties['fonts']?.properties?.['ui']?.enum).toEqual([...FONT_IDS.ui])
    expect(schema.properties['fonts']?.properties?.['mono']?.enum).toEqual([...FONT_IDS.mono])
  })
})

describe('library', () => {
  const mine: ThemeFile = { ...slicerxDark, id: 'mine', name: 'Mine', family: 'mine', familyName: 'Mine' }
  it('user themes extend the list and replace bundled ids', () => {
    expect(allThemes([mine]).map((t) => t.id)).toContain('mine')
    const replaced = allThemes([{ ...slicerxDark, name: 'Changed' }])
    expect(replaced.filter((t) => t.id === 'subban-dark')).toHaveLength(1)
    expect(replaced.find((t) => t.id === 'subban-dark')?.name).toBe('Changed')
  })
  it('a missing id falls back to the default of its slot', () => {
    expect(findTheme('deleted', 'dark').id).toBe('subban-dark')
    expect(findTheme('deleted', 'light').id).toBe('subban-light')
  })
  it('the earlier ids of the default theme reach Subban', () => {
    for (const [old, now] of Object.entries(LEGACY_THEME_IDS)) {
      expect(migrateThemeId(old)).toBe(now)
      expect(findTheme(old, 'dark').id).toBe(now)
    }
    expect(migrateThemeId('slicerx-dark')).toBe('subban-dark')
    expect(migrateThemeId('nocturne')).toBe('subban-dark')
    expect(migrateThemeId('nocturne-light')).toBe('subban-light')
    expect(migrateThemeId('tokyo-night')).toBe('tokyo-night')
  })
  it('picking fills the slot of the theme brightness', () => {
    expect(pickTheme(DEFAULT_THEME_IDS, mine)).toEqual({ dark: 'mine', light: 'subban-light' })
    const tokyo = BUNDLED_THEMES.find((t) => t.id === 'github-light') as ThemeFile
    expect(pickTheme(DEFAULT_THEME_IDS, tokyo)).toEqual({ dark: 'subban-dark', light: 'github-light' })
    expect(themeForScheme('light', { dark: 'mine', light: 'github-light' }, [mine], BUNDLED_THEMES).id).toBe('github-light')
    // without the bundle (the app at startup), a theme the person has not cached falls back to Subban
    expect(themeForScheme('light', { dark: 'mine', light: 'github-light' }, [mine]).id).toBe('subban-light')
  })
  it('carries only Subban at startup, the same files the bundle has', () => {
    expect(DEFAULT_THEMES.map((t) => t.id)).toEqual(['subban-dark', 'subban-light'])
    for (const t of DEFAULT_THEMES) expect(BUNDLED_THEMES.find((b) => b.id === t.id)).toEqual(t)
  })
  it('picking a family fills both slots, keeping or choosing the dark flavor', () => {
    const fam = (id: string) => themeFamilies(BUNDLED_THEMES).find((f) => f.id === id)!
    expect(pickFamily(DEFAULT_THEME_IDS, fam('nord'))).toEqual({ dark: 'nord', light: 'nord-light' })
    expect(pickFamily(DEFAULT_THEME_IDS, fam('catppuccin'))).toEqual({ dark: 'catppuccin-mocha', light: 'catppuccin-latte' })
    expect(pickFamily(DEFAULT_THEME_IDS, fam('catppuccin'), 'catppuccin-frappe')).toEqual({ dark: 'catppuccin-frappe', light: 'catppuccin-latte' })
    expect(pickFamily({ dark: 'catppuccin-macchiato', light: 'catppuccin-latte' }, fam('catppuccin'))).toEqual({ dark: 'catppuccin-macchiato', light: 'catppuccin-latte' })
    // a theme of one brightness only fills its own slot
    const solo = themeFamilies([...BUNDLED_THEMES, mine]).find((f) => f.id === 'mine')!
    expect(pickFamily(DEFAULT_THEME_IDS, solo)).toEqual({ dark: 'mine', light: 'subban-light' })
    expect(familyId(mine)).toBe('mine')
  })
  it('slugifies names', () => {
    expect(slugify('My Cool Theme!')).toBe('my-cool-theme')
    expect(slugify('***')).toBe('theme')
    expect(slugify('x'.repeat(60)).length).toBeLessThanOrEqual(40)
  })
})

describe('contrast of every bundled theme', () => {
  const grounds = (t: ThemeFile) => [t.background, t.surface]
  const atLeast = (c: string, t: ThemeFile, min: number) => grounds(t).every((g) => contrast(c, g) >= min - 1e-9)
  for (const t of BUNDLED_THEMES) {
    it(`${t.name}: text reaches AA and glyph colors 3:1`, () => {
      for (const g of grounds(t)) expect(contrast(t.text, g), `${t.id} text on ${g}`).toBeGreaterThanOrEqual(TEXT_CONTRAST)
      for (const vision of ['standard', 'redgreen', 'blueyellow'] as const) {
        const p = derivePalette(t, { colorVision: vision })
        for (const k of ['secondary', 'dim'] as const) expect(atLeast(p[k], t, TEXT_CONTRAST), `${t.id} ${vision} ${k} ${p[k]}`).toBe(true)
        for (const k of ['red', 'green', 'orange', 'yellow', 'blue', 'magenta', 'cyan'] as const) expect(atLeast(p[k], t, GLYPH_CONTRAST), `${t.id} ${vision} ${k} ${p[k]}`).toBe(true)
        if (!t.isDark) expect(atLeast(p.accent, t, GLYPH_CONTRAST), `${t.id} accent`).toBe(true)
        expect(contrast(p.onAccent, p.accent), `${t.id} ink on accent`).toBeGreaterThanOrEqual(GLYPH_CONTRAST)
      }
    })
    it(`${t.name}: higher contrast reaches 7:1 for secondary text and 4.5:1 for glyphs`, () => {
      const p = derivePalette(t, { contrast: 'higher' })
      for (const k of ['secondary', 'dim'] as const) expect(atLeast(p[k], t, HIGH_TEXT_CONTRAST) || p[k] === t.text, `${t.id} ${k}`).toBe(true)
      for (const k of ['red', 'green', 'orange', 'accent'] as const) expect(atLeast(p[k], t, TEXT_CONTRAST) || p[k] === t.text, `${t.id} ${k}`).toBe(true)
      expect(contrast(p.border, t.background)).toBeGreaterThan(contrast(t.border, t.background))
    })
  }
  it('color vision changes the colors that collide and keeps them apart from each other', () => {
    for (const t of BUNDLED_THEMES) {
      const std = derivePalette(t)
      const rg = derivePalette(t, { colorVision: 'redgreen' })
      const by = derivePalette(t, { colorVision: 'blueyellow' })
      expect(rg.green, t.id).not.toBe(std.green)
      expect(by.cyan, t.id).not.toBe(std.cyan)
      expect(new Set([rg.red, rg.green, rg.orange]).size, t.id).toBe(3)
      expect(new Set([by.red, by.green, by.orange, by.cyan]).size, t.id).toBe(4)
    }
  })
})

describe('family fields', () => {
  it('validates and keeps family, familyName and flavor', () => {
    const r = validateThemeFile({ ...good(), family: 'mine', familyName: 'Mine', flavor: 'Deep' })
    expect(r.ok && [r.theme.family, r.theme.familyName, r.theme.flavor]).toEqual(['mine', 'Mine', 'Deep'])
    const bad = validateThemeFile({ ...good(), family: 'Not A Slug', flavor: '' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/family must be.*flavor must be/)
  })
  it('round-trips through serializeTheme', () => {
    const r = parseThemeText(serializeTheme(BUNDLED_THEMES.find((t) => t.id === 'catppuccin-frappe') as ThemeFile))
    expect(r.ok && r.theme.flavor).toBe('Frappe')
  })
})
