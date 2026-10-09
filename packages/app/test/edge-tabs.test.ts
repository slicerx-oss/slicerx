// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The edge tabs on Model's and Slice's panes: the tab shuts and opens its pane through the rails store, [ and ] and
// Mod+J reach whichever panel draws a tab on that side, and Model's panes shut all the way.
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isMac } from '../src/lib/keys'
import { bindPlateKeys } from '../src/plate/keys'
import { registerEdge, toggleEdge } from '../src/shell/edge-keys'
import { SidePane } from '../src/shell/pane'
import { get, set } from '../src/state/store'

/** A window at a width: the pane reads 1280 px and up as wide and 900 px and under as a phone. */
function windowAt(width: number): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const min = /min-width: (\d+)px/.exec(q)
    const max = /max-width: (\d+)px/.exec(q)
    const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false
    return { matches, addEventListener() {}, removeEventListener() {} }
  })
}

type PaneProps = Parameters<typeof SidePane>[0]
const pane = (props: Partial<PaneProps> = {}, withTab = true) => {
  const all: PaneProps = { side: 'left', ws: 'prepare-design', label: 'Model', sections: [{ id: 'objects', icon: 'history', label: 'Model' }], children: createElement('p', null, 'tree'), ...(withTab ? { tab: { panel: 'model-tree', shutFully: true } } : {}), ...props }
  return render(createElement(SidePane, all))
}

describe('edge tabs on the side panes', () => {
  beforeEach(() => {
    windowAt(1440)
    set({ rails: {}, workspace: 'prepare', setup: null })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('draws one tab, no rail toggle, and shuts the pane all the way', () => {
    const { container, getByTestId } = pane()
    const tab = getByTestId('edge-tab-left')
    expect(tab.getAttribute('data-panel')).toBe('model-tree')
    expect(tab.getAttribute('aria-expanded')).toBe('true')
    expect(tab.getAttribute('aria-controls')).toBe(getByTestId('model-tree').id)
    expect(container.querySelector('.sx-rail-toggle')).toBeNull()
    fireEvent.click(tab)
    expect(get().rails['prepare-design']?.left).toBe(false)
    const aside = container.querySelector('aside')!
    expect(aside.hasAttribute('data-collapsed')).toBe(true)
    expect(aside.classList.contains('shuts')).toBe(true)
    // Shut all the way: no icon rail and no resize edge, only the tab on the window edge.
    expect(container.querySelector('.sx-rail-item')).toBeNull()
    expect(container.querySelector('.sx-resize-edge')).toBeNull()
    expect(tab.getAttribute('aria-expanded')).toBe('false')
    expect(tab.getAttribute('aria-label')).toBe('Open Model')
    fireEvent.click(tab)
    expect(get().rails['prepare-design']?.left).toBe(true)
    expect(getByTestId('model-tree').textContent).toBe('tree')
  })

  it('keeps Slice\'s icon rail while its sidebar is shut', () => {
    const { container, getByTestId } = pane({ ws: 'prepare', label: 'Printer and settings', tab: { panel: 'slice-sidebar' } })
    fireEvent.click(getByTestId('edge-tab-left'))
    expect(get().rails['prepare']?.left).toBe(false)
    expect(container.querySelector('aside')!.classList.contains('shuts')).toBe(false)
    expect(container.querySelector('.sx-rail-item')).not.toBeNull()
    // Model's panes are kept apart.
    expect(get().rails['prepare-design']).toBeUndefined()
  })

  it('shows the look\'s key in the tip', () => {
    const { getByTestId } = pane({ side: 'right', ws: 'prepare-design', label: 'Tool and transform', tab: { panel: 'model-inspector', shutFully: true } })
    expect(getByTestId('edge-tab-right').getAttribute('data-tip-key')).toBe(']')
  })

  it('has no tab on a phone, and panes without one keep the rail toggle', () => {
    windowAt(390)
    expect(pane().queryByTestId('edge-tab-left')).toBeNull()
    cleanup()
    windowAt(1440)
    const { container, queryByTestId } = pane({ ws: 'library', label: 'Folders' }, false)
    expect(queryByTestId('edge-tab-left')).toBeNull()
    expect(container.querySelector('.sx-rail-toggle')).not.toBeNull()
  })

  it('[ and ] toggle the pane on that side, as Mod+B does', async () => {
    pane()
    pane({ side: 'right', label: 'Tool and transform', tab: { panel: 'model-inspector', shutFully: true } })
    const off = bindPlateKeys(() => ({ id: 'slicerx' }) as never)
    const press = (key: string, extra: KeyboardEventInit = {}) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })))
    press('[')
    expect(get().rails['prepare-design']).toEqual({ left: false })
    press(']')
    expect(get().rails['prepare-design']).toEqual({ left: false, right: false })
    press('[')
    expect(get().rails['prepare-design']?.left).toBe(true)
    const { toggleRail } = await import('../src/commands/builtin')
    act(() => toggleRail('right'))
    expect(get().rails['prepare-design']?.right).toBe(true)
    off()
  })
})

describe('the panel keys', () => {
  afterEach(() => cleanup())

  it('reach the newest panel on a side, and nothing once it is gone', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = registerEdge('bottom', a)
    const offB = registerEdge('bottom', b)
    offA()
    expect(toggleEdge('bottom')).toBe(true)
    expect(b).toHaveBeenCalledOnce()
    expect(a).not.toHaveBeenCalled()
    offB()
    expect(toggleEdge('bottom')).toBe(false)
  })

  it('Mod+J toggles the bottom panel, and keys typed in a field stay there', () => {
    const t = vi.fn()
    const offT = registerEdge('bottom', t)
    set({ workspace: 'prepare', setup: null })
    const off = bindPlateKeys(() => ({ id: 'slicerx' }) as never)
    const mac = isMac()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }))
    expect(t).toHaveBeenCalledOnce()
    const input = document.body.appendChild(document.createElement('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }))
    expect(get().rails['prepare-design']?.left).not.toBe(false)
    input.remove()
    off()
    offT()
  })
})
