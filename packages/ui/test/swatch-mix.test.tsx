// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A mixed filament's swatch: diagonal stripes of its two colors, as wide as their share of the layers.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SwatchRing } from '../src/components/swatch-ring'

describe('SwatchRing with a mix', () => {
  it('fills the disc with stripes of the two colors in the ratio', () => {
    const html = renderToStaticMarkup(<SwatchRing color="#bc00bc" mix={{ a: '#ff0000', b: '#0000ff', ratio: [2, 1] }} />)
    expect(html).toMatch(/<pattern id="(sx-swatch-mix-[^"]+)" width="6" height="6"[^>]*patternTransform="rotate\(45 16 16\)"/)
    expect(html).toContain('<rect width="6" height="6" fill="#0000ff"></rect><rect width="4" height="6" fill="#ff0000"></rect>')
    expect(html).toMatch(/class="sx-swatch-disc"[^>]*fill="url\(#sx-swatch-mix-/)
    expect(html).toContain('data-mix="true"')
  })

  it('draws a plain disc without a mix, and a checker for colors it cannot read', () => {
    expect(renderToStaticMarkup(<SwatchRing color="#ff0000" />)).not.toContain('sx-swatch-mix')
    expect(renderToStaticMarkup(<SwatchRing color="#ff0000" mix={{ a: 'red', b: '#0000ff', ratio: [1, 1] }} />)).not.toContain('sx-swatch-mix')
  })
})
