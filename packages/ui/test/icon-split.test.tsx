// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shell carries only the startup icons; the rest draw as an empty box of the same size until their table loads.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { STARTUP_ICONS } from '../icons/startup.mjs'
import { ICON_PATHS } from '../src/icons/icon-paths'
import { STARTUP_ICON_PATHS } from '../src/icons/icon-startup'
import { Icon, iconsReady, isIconName } from '../src/icons/icon'

describe('the split icon table', () => {
  it('draws a startup icon at once and holds a box for the others until their table arrives', async () => {
    const startup = renderToStaticMarkup(<Icon name="slice" size={20} />)
    expect(startup).toContain(ICON_PATHS.slice)
    expect(startup).not.toContain('data-icon-pending')
    const late = renderToStaticMarkup(<Icon name="walls" size={20} />)
    expect(late).toContain('data-icon-pending="walls"')
    expect(late).toContain('width="20"')
    expect(late).toContain('height="20"')
    expect(late).not.toContain('<path')
    await iconsReady()
    const loaded = renderToStaticMarkup(<Icon name="walls" size={20} />)
    expect(loaded).toContain(ICON_PATHS.walls)
    expect(loaded).not.toContain('data-icon-pending')
  })

  it('keeps the startup table to the listed icons, drawn as in the full table', () => {
    expect(Object.keys(STARTUP_ICON_PATHS).sort()).toEqual([...STARTUP_ICONS].sort())
    for (const [name, markup] of Object.entries(STARTUP_ICON_PATHS)) expect(markup, name).toBe(ICON_PATHS[name as keyof typeof ICON_PATHS])
    expect(Object.keys(STARTUP_ICON_PATHS).length).toBeLessThan(Object.keys(ICON_PATHS).length / 2)
  })

  it('knows every icon name without the full table', () => {
    for (const name of Object.keys(ICON_PATHS)) expect(isIconName(name), name).toBe(true)
    expect(isIconName('not-an-icon')).toBe(false)
    expect(isIconName(3)).toBe(false)
  })
})
