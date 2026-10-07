// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first tab (id `prepare`) is Slice in every look (Design | Slice when the edition has modeling tools). Every
// sentence that points at it takes the name from the look, so a look could still rename it.
import type { LookId } from '@slicerx/contracts'
import { resolvePreset } from '@slicerx/ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { actionLabel, groupLabel } from '../src/controls/actions'
import { ControlsSection } from '../src/controls/section'
import { orderWorkspaces, tabLabel, topBarTabs } from '../src/first-run/look'
import { set } from '../src/state/store'

const WANT: readonly [LookId, string][] = [
  ['slicerx', 'Slice'],
  ['bambu-studio', 'Slice'],
  ['orcaslicer', 'Slice'],
  ['prusaslicer', 'Slice'],
]

const WORKSPACES = [
  { id: 'prepare', label: 'Slice', icon: 'slice' as const, component: null },
  { id: 'printers', label: 'Printers', icon: 'printer' as const, component: null },
]

describe('the name of the first tab follows the look', () => {
  it.each(WANT)('%s calls it %s', (id, name) => {
    const layout = resolvePreset(id).layout
    expect(tabLabel(layout, 'prepare')).toBe(name)
    expect(topBarTabs(WORKSPACES, layout)[0]).toMatchObject({ id: 'prepare', label: name })
    // The id never changes.
    expect(orderWorkspaces(WORKSPACES, layout).map((w) => w.id)).toContain('prepare')
  })

  it('keeps the other names and falls back to the id', () => {
    const slicerx = resolvePreset('slicerx').layout
    expect(tabLabel(slicerx, 'library')).toBe('Vault')
    expect(tabLabel(resolvePreset('bambu-studio').layout, 'printers')).toBe('Device')
    expect(tabLabel(slicerx, 'something-new')).toBe('something-new')
  })

  it.each(WANT)('the shortcut texts use the name for %s: %s', (_id, name) => {
    expect(actionLabel('workspace.toggle', name)).toBe('Switch between toolpaths and solid models')
    expect(groupLabel('Prepare', name)).toBe(name)
    // Other groups and actions keep their own text.
    // The layer keys are listed as Layers: there is no Preview tab.
    expect(groupLabel('Preview', name)).toBe('Layers')
    expect(actionLabel('slice', name)).toBe('Slice the plate')
  })
})

describe('Settings > Controls', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    set({ lookAndFeel: null })
  })

  it.each(WANT)('%s names the plate shortcut group %s', (id, name) => {
    set({ lookAndFeel: { id } })
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    flushSync(() => root.render(createElement(ControlsSection)))
    const groups = [...el.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))
    expect(groups).toContain(`${name} shortcuts`)
    if (name !== 'Prepare') expect(groups).not.toContain('Prepare shortcuts')
    expect(el.textContent).toContain('Switch between toolpaths and solid models')
    root.unmount()
  })
})
