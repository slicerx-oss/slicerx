// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A panel's edge tab says what it does and to which panel, points where the panel will go, and carries its test id.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EdgeTab, edgeChevron, type EdgeSide } from '../src/components/edge-tab'

const noop = () => undefined
const tab = (side: EdgeSide, open: boolean, extra: Partial<Parameters<typeof EdgeTab>[0]> = {}) => renderToStaticMarkup(<EdgeTab side={side} open={open} label="Model tree" onToggle={noop} {...extra} />)

describe('the edge tab', () => {
  it('names the panel and whether pressing it opens or closes it', () => {
    const html = tab('left', true, { controls: 'pane-left', shortcut: '[', panel: 'model-tree' })
    expect(html).toContain('data-panel="model-tree"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-controls="pane-left"')
    expect(html).toContain('aria-label="Close Model tree"')
    expect(html).toContain('data-tip-title="Model tree"')
    expect(html).toContain('data-tip-key="["')
    expect(tab('left', false)).toContain('aria-label="Open Model tree"')
  })

  it('points where the panel goes', () => {
    expect(edgeChevron('left', true)).toBe('left')
    expect(edgeChevron('left', false)).toBe('right')
    expect(edgeChevron('right', true)).toBe('right')
    expect(edgeChevron('right', false)).toBe('left')
    expect(edgeChevron('bottom', true)).toBe('down')
    expect(edgeChevron('bottom', false)).toBe('up')
    expect(tab('bottom', false)).toContain('data-dir="up"')
  })

  it('carries edge-tab-<side>', () => {
    for (const side of ['left', 'right', 'bottom'] as const) {
      const html = tab(side, false)
      expect(html).toContain(`data-testid="edge-tab-${side}"`)
      expect(html).toContain(`data-side="${side}"`)
      expect(html).toContain('class="sx-edge-tab sx-overlay"')
    }
  })
})

describe('a rail with an edge tab', () => {
  it('draws no header toggle of its own, so there is one control', async () => {
    const { Rail } = await import('../src/components/rail')
    const rail = (toggle?: boolean) => renderToStaticMarkup(<Rail side="left" label="Model" collapsed={false} onCollapsedChange={noop} {...(toggle === undefined ? {} : { toggle })} />)
    expect(rail()).toContain('sx-rail-toggle')
    expect(rail(false)).not.toContain('sx-rail-toggle')
  })
})
