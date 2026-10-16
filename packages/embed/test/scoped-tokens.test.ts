// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tokens built from the palette are declared again on the EmbedTheme wrapper, so a scoped light theme gets light
// surfaces (the view's tool bar, menus) instead of the default dark ones computed on the host. edition-check.mjs checks
// the drawn bar in a browser.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { themedTokens } from '../src/styles'

// read from disk: the test runner hands CSS imports over empty
const tokens = readFileSync(createRequire(import.meta.url).resolve('@slicerx/ui/tokens.css'), 'utf8')

const block = (css: string, selector: string) => css.split(`${selector} {\n`)[1]?.split('\n}')[0] ?? ''

describe('tokens on the EmbedTheme wrapper', () => {
  const css = themedTokens(tokens)

  it('redeclares the tokens built from the palette, and leaves fixed values to the host', () => {
    const base = block(css, '.sx-theme-scope')
    expect(base).toContain('--surface-card: color-mix(in srgb, var(--ink-1), var(--fg) 7%);')
    expect(base).toContain('--surface-float: color-mix(in srgb, var(--surface-card) 92%, transparent);')
    expect(base).toContain('--overlay: var(--surface-float);')
    expect(base).not.toContain('--line-soft: #3c3e4f;')
  })

  it('applies the light surfaces and icon shades when the wrapper theme is light', () => {
    expect(block(css, '.sx-theme-scope[data-scheme="light"]')).toContain('--surface-float: color-mix(in srgb, #ffffff 92%, transparent);')
    expect(block(css, '.sx-theme-scope[style*="color-scheme: light"]')).toContain('--ti-a2: var(--accent);')
  })
})
