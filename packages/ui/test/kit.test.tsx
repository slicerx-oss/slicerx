// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChipButton } from '../src/components/chip-button'
import { Popover } from '../src/components/popover'
import { Rail } from '../src/components/rail'
import { SelectionBar } from '../src/components/selection-bar'
import { SplitButton } from '../src/components/split-button'
import { SwatchRing } from '../src/components/swatch-ring'

const noop = () => undefined

describe('chip button', () => {
  it('is a button that says it opens a menu, with tabular numbers when asked', () => {
    const html = renderToStaticMarkup(<ChipButton menu numeric data-testid="machine-nozzle">0.4 mm</ChipButton>)
    expect(html).toMatch(/^<button type="button" class="sx-chip-btn" aria-haspopup="menu" data-numeric="true"/)
    expect(html).toContain('data-testid="machine-nozzle"')
    expect(html).toContain('<span class="sx-chip-btn-label">0.4 mm</span>')
  })
})

describe('split button', () => {
  it('renders two named buttons, the menu half with its own props', () => {
    const html = renderToStaticMarkup(
      <SplitButton variant="primary" size="lg" full icon="send-to-printer" menuLabel="More ways to print" menuOpen={false} onMenu={noop} menuProps={{ 'data-testid': 'output-menu' }} data-testid="danger-print">
        Print
      </SplitButton>,
    )
    expect(html.match(/<button\b/g)).toHaveLength(2)
    expect(html).toContain('data-testid="danger-print"')
    expect(html).toContain('aria-label="More ways to print" aria-haspopup="menu" aria-expanded="false" data-testid="output-menu"')
    expect(html).toContain('data-full="true"')
  })

  it('keeps a disabled main half with a reason hoverable', () => {
    const html = renderToStaticMarkup(<SplitButton menuLabel="More" menuOpen={false} onMenu={noop} disabled tip={{ title: 'Print', reason: 'Add a model to the plate.' }}>Print</SplitButton>)
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toMatch(/sx-split-main"[^>]*\bdisabled=""/)
  })
})

describe('selection bar', () => {
  it('is a toolbar with a live count, the actions and a clear button', () => {
    const html = renderToStaticMarkup(<SelectionBar count="2 selected" onClear={noop} data-testid="selection-bar"><button type="button">Skip</button></SelectionBar>)
    expect(html).toContain('role="toolbar" aria-label="Selection"')
    expect(html).toContain('class="sx-selbar sx-overlay"')
    expect(html).toContain('<span class="sx-selbar-count" aria-live="polite">2 selected</span>')
    expect(html).toContain('aria-label="Clear selection"')
  })
})

describe('swatch ring', () => {
  it('draws the usage as an arc of the right length', () => {
    const half = renderToStaticMarkup(<SwatchRing color="#ff0000" usage={0.5} />)
    const length = 2 * Math.PI * 15
    expect(half).toContain(`stroke-dasharray="${(0.5 * length).toFixed(2)} ${length.toFixed(2)}"`)
    expect(renderToStaticMarkup(<SwatchRing color="#ff0000" usage={0} />)).not.toContain('sx-swatch-arc')
    expect(renderToStaticMarkup(<SwatchRing color="#ff0000" usage={2} />)).toContain(`stroke-dasharray="${length.toFixed(2)} ${length.toFixed(2)}"`)
    expect(renderToStaticMarkup(<SwatchRing color="#ff0000" />)).not.toContain('sx-swatch-track')
  })

  it('outlines the disc, and draws an unknown color as a checker with its own pattern id', () => {
    const html = renderToStaticMarkup(
      <>
        <SwatchRing color="nope" />
        <SwatchRing color="also nope" />
      </>,
    )
    const ids = [...html.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1])
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(html).toContain(`fill="url(#${ids[0]})"`)
    expect(html).toContain('class="sx-swatch-disc"')
  })

  it('shows the dim, selected, mismatch and label states', () => {
    const html = renderToStaticMarkup(<SwatchRing color="#00ff00" label="A2" dim selected mismatch />)
    expect(html).toContain('data-dim="true"')
    expect(html).toContain('data-selected="true"')
    expect(html).toContain('class="sx-swatch-mismatch"')
    expect(html).toContain('<span class="sx-swatch-label">A2</span>')
  })
})

describe('rail header slot', () => {
  it('shows the extra control only while expanded', () => {
    const open = renderToStaticMarkup(<Rail side="left" label="Printer and settings" collapsed={false} onCollapsedChange={noop} headExtra={<span>Simple</span>} />)
    expect(open).toContain('<span class="sx-rail-extra"><span>Simple</span></span>')
    const closed = renderToStaticMarkup(<Rail side="left" label="Printer and settings" collapsed onCollapsedChange={noop} headExtra={<span>Simple</span>} />)
    expect(closed).not.toContain('sx-rail-extra')
  })
})

describe('popover', () => {
  it('renders a lifted dialog when open and nothing when closed', () => {
    const html = renderToStaticMarkup(<Popover open label="Plate type" onClose={noop}><button type="button">Cool plate</button></Popover>)
    expect(html).toContain('role="dialog" aria-label="Plate type" class="sx-popover sx-overlay"')
    expect(renderToStaticMarkup(<Popover open={false} label="Plate type" onClose={noop} />)).toBe('')
  })
})
