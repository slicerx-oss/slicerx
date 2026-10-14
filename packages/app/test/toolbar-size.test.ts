// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Look and feel > Toolbar size: Large by default, stored with the rest of the look, a bad value falling
// back to Large, and the row's Seg writing it. The ribbon reads it as its icon size.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Host } from '@slicerx/contracts'
import { builtinTools } from '@slicerx/pilot'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinCommands } from '../src/commands/builtin'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { ToolbarGroup } from '../src/shell/appearance-settings'
import { DEFAULT_APPEARANCE, loadPrefs, savePrefs } from '../src/state/prefs'
import { get, set } from '../src/state/store'
import { TOOLBAR_ICON } from '../src/workspaces/design/ribbon-layout'

const KEY = 'slicerx.prefs.v1'

beforeEach(() => {
  localStorage.clear()
  set({ appearance: DEFAULT_APPEARANCE })
})
afterEach(() => cleanup())

describe('toolbar size', () => {
  it('is Large by default, with 32 px icons', () => {
    expect(DEFAULT_APPEARANCE.toolbarSize).toBe('large')
    expect(loadPrefs().appearance?.toolbarSize ?? DEFAULT_APPEARANCE.toolbarSize).toBe('large')
    expect(TOOLBAR_ICON).toEqual({ large: 32, medium: 24, small: 16 })
  })

  it('keeps a stored size and drops a bad one', () => {
    localStorage.setItem(KEY, JSON.stringify({ appearance: { toolbarSize: 'small' } }))
    expect(loadPrefs().appearance?.toolbarSize).toBe('small')
    localStorage.setItem(KEY, JSON.stringify({ appearance: { toolbarSize: 'huge' } }))
    expect(loadPrefs().appearance?.toolbarSize).toBe('large')
    localStorage.setItem(KEY, JSON.stringify({ appearance: { textSize: 'large' } }))
    expect(loadPrefs().appearance).toMatchObject({ textSize: 'large', toolbarSize: 'large' })
  })

  it('round-trips through the stored look', () => {
    savePrefs({ ...loadPrefs(), appearance: { ...DEFAULT_APPEARANCE, toolbarSize: 'medium' } })
    expect(loadPrefs().appearance?.toolbarSize).toBe('medium')
  })

  it('the Look and feel row sets it and says what it does', () => {
    render(createElement(ToolbarGroup))
    expect(screen.getByTestId('set-toolbar-size').textContent).toContain('32 px')
    fireEvent.click(screen.getByRole('radio', { name: 'Small' }))
    expect(get().appearance.toolbarSize).toBe('small')
    expect(screen.getByTestId('set-toolbar-size').textContent).toContain('Hover one for its name')
    fireEvent.click(screen.getByRole('radio', { name: 'Medium' }))
    expect(get().appearance.toolbarSize).toBe('medium')
  })
})

describe('model framing', () => {
  it('frames each pick by default, keeps a stored choice and falls back on a bad one', () => {
    expect(DEFAULT_APPEARANCE.modelFraming).toBe('selection')
    savePrefs({ ...loadPrefs(), appearance: { ...DEFAULT_APPEARANCE, modelFraming: 'open' } })
    expect(loadPrefs().appearance?.modelFraming).toBe('open')
    localStorage.setItem(KEY, JSON.stringify({ appearance: { modelFraming: 'sometimes' } }))
    expect(loadPrefs().appearance?.modelFraming).toBe('selection')
  })

  it('mimir sets it through the app.model_framing_* tools and reads the choice back', async () => {
    setCurrentEdition(NEUTRAL)
    // the tools mimir may call: the enabled commands, as a call to a disabled one is refused
    const tools = () => builtinTools({ planner: undefined, commands: builtinCommands({} as Host, []).filter((c) => (c.enabled ? c.enabled() : true)) })
    const named = (n: string) => tools().find((t) => t.name === n)
    expect(named('app.model_framing_selection')).toBeUndefined()
    const open = named('app.model_framing_open')!
    expect(open.permission).toBe('read')
    const out = await open.run({} as never, {} as never)
    expect(out.output).toEqual({ modelFraming: 'open' })
    expect(get().appearance.modelFraming).toBe('open')
    expect(named('app.model_framing_open')).toBeUndefined()
    expect((await named('app.model_framing_selection')!.run({} as never, {} as never)).output).toEqual({ modelFraming: 'selection' })
    // an edition without Model offers neither
    setCurrentEdition({ ...NEUTRAL, features: { ...NEUTRAL.features, cad: false } })
    expect(tools().filter((t) => t.name.startsWith('app.model_framing'))).toEqual([])
    setCurrentEdition(NEUTRAL)
  })
})
