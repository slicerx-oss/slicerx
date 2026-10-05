// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition that names its brand fonts gets them with a sans-serif fallback stack, so a missing face never shows as serif.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEditionConfig } from '@slicerx/edition-config'
import { describe, expect, it } from 'vitest'
import { editionTheme } from '../src/edition'

const acme = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../edition-config/fixtures/acme/acme.json'), 'utf8'))

describe('edition fonts', () => {
  it('adds a sans-serif stack after the brand families', () => {
    const edition = parseEditionConfig({ ...acme, brand: { ...acme.brand, theme: { base: 'nocturne', tokens: { fonts: { display: 'Sora', body: 'Manrope', mono: 'JetBrains Mono' } } } } })
    const { fonts } = editionTheme(edition, 'dark')
    expect(fonts.display).toMatch(/^"Sora", .*sans-serif$/)
    expect(fonts.body).toMatch(/^"Manrope", .*sans-serif$/)
    expect(fonts.mono).toMatch(/^"JetBrains Mono", .*monospace$/)
    for (const f of [fonts.display, fonts.body]) expect(f).not.toMatch(/(^|,)\s*serif\b/)
  })
})
