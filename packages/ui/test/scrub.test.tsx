// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOOK_IDS } from '../src/lookfeel'
import { ScrubNumber, VectorField, scrubFactor, spokenUnit } from '../src/components/scrub'

const noop = () => undefined

describe('vector field', () => {
  for (const id of LOOK_IDS) {
    it(`renders one outline with a colored handle per axis in the ${id} look`, () => {
      const html = renderToStaticMarkup(
        <div data-look={id}>
          <VectorField id="tf-position" label="Position" unit="mm" values={[165, 160, 0]} onCommit={noop} />
        </div>,
      )
      expect(html.match(/role="group"/g)).toHaveLength(1)
      expect(html).toContain('aria-label="Position"')
      expect(html.match(/class="sx-vector-box"/g)).toHaveLength(1)
      // The unit is said once, beside the name.
      expect(html).toContain('Position<small>mm</small>')
      const inputs = html.match(/<input\b[^>]*>/g) ?? []
      expect(inputs).toHaveLength(3)
      for (const [i, a] of ['X', 'Y', 'Z'].entries()) {
        expect(inputs[i]).toContain(`id="tf-position-${a.toLowerCase()}"`)
        expect(inputs[i]).toContain(`aria-label="Position ${a}, millimeters"`)
        expect(inputs[i]).toContain(`value="${[165, 160, 0][i]}"`)
      }
      const handles = html.match(/<span class="sx-scrub-handle"[^>]*>[^<]*<\/span>/g) ?? []
      expect(handles).toHaveLength(3)
      for (const [i, a] of ['x', 'y', 'z'].entries()) {
        expect(handles[i]).toContain(`data-axis="${a}"`)
        expect(handles[i]).toContain('aria-hidden="true"')
        expect(handles[i]).toContain(`>${a.toUpperCase()}<`)
      }
      // Body face numbers: no mono class left on the fields.
      expect(html).not.toContain('sx-mono')
    })
  }

  it('says degrees and percent in full', () => {
    const rot = renderToStaticMarkup(<VectorField id="r" label="Rotation" unit="°" values={[0, 0, 90]} onCommit={noop} />)
    expect(rot).toContain('Rotation<small>degrees</small>')
    expect(rot).toContain('aria-label="Rotation Z, degrees"')
    expect(spokenUnit('%')).toBe('percent')
  })

  it('takes two axes, and a plain field gets a plain handle only when asked', () => {
    const two = renderToStaticMarkup(<VectorField id="t" label="Tilt" unit="°" axes={['x', 'y']} values={[10, -5]} onCommit={noop} />)
    expect(two.match(/<input\b/g)).toHaveLength(2)
    const plain = renderToStaticMarkup(<ScrubNumber id="n" ariaLabel="Number of instances" value={3} digits={0} onCommit={noop} />)
    expect(plain).not.toContain('sx-scrub-handle')
    expect(plain).toContain('data-boxed="true"')
    const grip = renderToStaticMarkup(<ScrubNumber id="o" ariaLabel="Offset, millimeters" value={2.5} handle onCommit={noop} />)
    expect(grip).toMatch(/class="sx-scrub-handle" aria-hidden="true"/)
  })

  it('scales a step 10x with Shift and 0.1x with Alt', () => {
    expect(scrubFactor({ shiftKey: false, altKey: false })).toBe(1)
    expect(scrubFactor({ shiftKey: true, altKey: false })).toBe(10)
    expect(scrubFactor({ shiftKey: false, altKey: true })).toBe(0.1)
  })
})
