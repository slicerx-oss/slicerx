// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { fontBase64, listLocalFonts, localFontsAvailable, pickFamilies, type LocalFont } from '../src/cad/fonts'

const font = (family: string, style: string, bytes = [1, 2, 3]): LocalFont => ({ family, style, postscriptName: `${family}-${style}`, blob: async () => new Blob([new Uint8Array(bytes)]) })

describe('installed fonts for the text tool', () => {
  it('keeps one entry per family, preferring the regular style, sorted by name', () => {
    const list = pickFamilies([font('Zilla', 'Bold'), font('Arial', 'Italic'), font('Arial', 'Regular'), font('Arial', 'Bold'), font('Zilla', 'Light'), font('', 'Regular')])
    expect(list.map((c) => c.family)).toEqual(['Arial', 'Zilla'])
    expect(list[0]!.font.style).toBe('Regular')
    expect(list[1]!.font.style).toBe('Bold')
  })

  it('is empty where the browser cannot list fonts, or when asked and refused', async () => {
    expect(localFontsAvailable({})).toBe(false)
    expect(await listLocalFonts({})).toEqual([])
    expect(await listLocalFonts({ queryLocalFonts: async () => Promise.reject(new Error('denied')) })).toEqual([])
    expect(localFontsAvailable({ queryLocalFonts: async () => [] })).toBe(true)
  })

  it('lists what the browser offers', async () => {
    const list = await listLocalFonts({ queryLocalFonts: async () => [font('Mono', 'Regular')] })
    expect(list.map((c) => c.family)).toEqual(['Mono'])
  })

  it('reads a font file as base64 for the engine', async () => {
    const [c] = pickFamilies([font('Mono', 'Regular', [72, 105])])
    expect(await fontBase64(c!)).toBe('SGk=')
  })
})
