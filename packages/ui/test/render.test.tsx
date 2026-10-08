// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FONTS_HREF } from '../src/tokens'
import { GALLERY_CSS, Gallery } from '../src/gallery'
import { forge, nocturneLight } from '../src/themes'
import type { Theme } from '../src/theme'
import { iconsReady } from '../src/icons/icon'

/** Writes the gallery as a standalone page for design review screenshots. */
function writeGallery(out: string, palette: boolean, theme?: Theme) {
  const here = resolve(import.meta.dirname)
  const tokens = readFileSync(resolve(here, '../src/tokens.css'), 'utf8')
  const styles = readFileSync(resolve(here, '../src/styles.css'), 'utf8').replace('@import "./tokens.css";', tokens)
  const body = renderToStaticMarkup(<Gallery palette={palette} theme={theme} />)
  writeFileSync(
    out,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SlicerX UI gallery</title><link rel="stylesheet" href="${FONTS_HREF}"><style>${styles}\n${GALLERY_CSS}</style></head><body>${body}</body></html>`,
  )
}

describe('gallery', () => {
  it('renders every primitive on the server without a DOM', () => {
    const html = renderToStaticMarkup(<Gallery palette />)
    expect(html).toContain('sx-appbar')
    expect(html).toContain('sx-palette')
    expect(html).toContain('sx-rail')
    expect(html).toContain('aria-label="SlicerX"')
    expect(html).toContain('The AI-ready slicer')
    expect(html).toContain('mimir')
    // Every form control carries an id.
    const controls = html.match(/<(input|select|textarea)\b[^>]*>/g) ?? []
    expect(controls.length).toBeGreaterThan(5)
    for (const c of controls) expect(c, c).toMatch(/\bid="/)
    // No inline hex colors and no dashes leak into markup.
    expect(html).not.toMatch(/style="[^"]*#[0-9a-f]{3,6}/i)
    expect(html).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + ']'))
  })

  // GALLERY_OUT=/path/dir pnpm test writes gallery.html and gallery-palette.html there.
  it('writes the gallery page when asked', async () => {
    const dir = process.env['GALLERY_OUT']
    if (!dir) return
    // every icon drawn, not the empty boxes the late ones hold until their table loads
    await iconsReady()
    writeGallery(resolve(dir, 'gallery.html'), false)
    writeGallery(resolve(dir, 'gallery-palette.html'), true)
    writeGallery(resolve(dir, 'gallery-light.html'), false, nocturneLight)
    writeGallery(resolve(dir, 'gallery-forge.html'), false, forge)
  })
})
