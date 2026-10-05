// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BRAND_LOGOS, BRAND_SLUGS, BrandLogo, OfficialMark, OFFICIAL_MARKS, hasOfficialMark } from '../src/index'

const logos = BRAND_SLUGS.map((slug) => BRAND_LOGOS[slug])

describe('brand logo records', () => {
  it('has unique slugs that match their keys', () => {
    expect(new Set(BRAND_SLUGS).size).toBe(BRAND_SLUGS.length)
    for (const slug of BRAND_SLUGS) expect(BRAND_LOGOS[slug].slug).toBe(slug)
  })

  it.each(logos.map((l) => [l.slug, l] as const))('%s is complete', (_slug, l) => {
    expect(l.slug).not.toBe('')
    expect(l.title).not.toBe('')
    expect(l.viewBox).toMatch(/^-?[\d.]+( -?[\d.]+){3}$/)
    expect(l.svg.trim()).not.toBe('')
    expect(l.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(l.source.startsWith('https://')).toBe(true)
    expect(l.license).not.toBe('')
    expect(l.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    if (l.colorSvg !== undefined) expect(l.colorSvg.trim()).not.toBe('')
  })

  it.each(logos.map((l) => [l.slug, l] as const))('%s markup is inert', (_slug, l) => {
    for (const markup of [l.svg, l.colorSvg ?? '']) {
      expect(markup).not.toMatch(/<script/i)
      expect(markup).not.toMatch(/<foreignObject/i)
      expect(markup).not.toMatch(/\son[a-z]+\s*=/i)
      expect(markup).not.toMatch(/href\s*=\s*["'](?!#)/i)
      expect(markup).not.toMatch(/url\(\s*["']?(?!#)/i)
    }
  })
})

describe('BrandLogo', () => {
  for (const slug of BRAND_SLUGS) {
    for (const variant of ['mono', 'color'] as const) {
      it(`renders ${slug} (${variant})`, () => {
        const hidden = renderToStaticMarkup(createElement(BrandLogo, { slug, variant }))
        expect(hidden).toContain('aria-hidden="true"')
        expect(hidden).not.toContain('role=')
        const named = renderToStaticMarkup(createElement(BrandLogo, { slug, variant, title: 'Works with', size: 32 }))
        expect(named).toContain('role="img"')
        expect(named).toContain('aria-label="Works with"')
        expect(named).not.toContain('aria-hidden')
        expect(named).toContain('width="32"')
      })
    }
  }

  it('uses currentColor for mono and the brand hex for color', () => {
    expect(renderToStaticMarkup(createElement(BrandLogo, { slug: 'claude' }))).toContain('fill="currentColor"')
    expect(renderToStaticMarkup(createElement(BrandLogo, { slug: 'claude', variant: 'color' }))).toContain(
      `fill="${BRAND_LOGOS.claude.color}"`,
    )
  })
})

describe('official maker marks', () => {
  it('records source, license and files for each mark', () => {
    for (const [slug, m] of Object.entries(OFFICIAL_MARKS)) {
      expect(m.slug).toBe(slug)
      expect(m.source.startsWith('https://')).toBe(true)
      expect(m.license).toContain('Permission reported by the maintainers, 2026-09-30')
      expect(m.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      for (const url of [m.dark, m.light]) expect(existsSync(fileURLToPath(url)), url).toBe(true)
    }
  })

  it('renders the dark file by default and the light file on request', () => {
    expect(renderToStaticMarkup(createElement(OfficialMark, { slug: 'prusa' }))).toContain('prusa-white.png')
    expect(renderToStaticMarkup(createElement(OfficialMark, { slug: 'prusa', on: 'light' }))).toContain('prusa-black.png')
    expect(hasOfficialMark('prusa')).toBe(true)
    expect(hasOfficialMark('bambu-lab')).toBe(false)
  })
})
