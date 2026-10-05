// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first tab (id `prepare`) is Model in the SlicerX style, Prepare in the Bambu and Orca styles and Plater in
// the PrusaSlicer style. Every sentence that points at it takes the name from the look.
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
  ['slicerx', 'Model'],
  ['bambu-studio', 'Prepare'],
  ['orcaslicer', 'Prepare'],
  ['prusaslicer', 'Plater'],
]

const WORKSPACES = [
  { id: 'prepare', label: 'Prepare', icon: 'prepare' as const, component: null },
  { id: 'preview', label: 'Preview', icon: 'preview' as const, component: null },
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
    expect(tabLabel(slicerx, 'preview')).toBe('Preview')
    expect(tabLabel(resolvePreset('bambu-studio').layout, 'printers')).toBe('Device')
    expect(tabLabel(slicerx, 'something-new')).toBe('something-new')
  })

  it.each(WANT)('the shortcut texts use the name for %s: %s', (_id, name) => {
    expect(actionLabel('workspace.toggle', name)).toBe(`Switch between ${name} and Preview`)
    expect(groupLabel('Prepare', name)).toBe(name)
    // Other groups and actions keep their own text.
    expect(groupLabel('Preview', name)).toBe('Preview')
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
    expect(el.textContent).toContain(`Switch between ${name} and Preview`)
    root.unmount()
  })
})
