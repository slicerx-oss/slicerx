// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Look and feel and the first-run theme step: the theme cards, the mode, flavors, accent,
// text, contrast and color vision, how they are stored, and how the old settings move over.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { resolvePreset } from '@slicerx/ui'
import { bodyPx, typeVars } from '@slicerx/ui/theme'
import { EditionContext, NEUTRAL } from '../src/edition'
import { HostContext } from '../src/host'
import { withAppearance } from '../src/first-run/look'
import { AccessibilityGroup, AccentGroup, EasierToRead, TextGroup } from '../src/shell/appearance-settings'
import { familySubLabel, ThemeModeSeg, ThemePicker } from '../src/shell/theme-settings'
import { DEFAULT_APPEARANCE, loadPrefs, savePrefs } from '../src/state/prefs'
import { colorblindToolpaths, get, set } from '../src/state/store'

const HOST = { kind: 'web', capabilities: { secureStorage: false }, files: { save: async () => undefined } } as unknown as Host
const mount = (el: ReturnType<typeof createElement>) => render(createElement(HostContext.Provider, { value: HOST }, createElement(EditionContext.Provider, { value: NEUTRAL }, el)))

beforeEach(() => set({ themeIds: { dark: 'subban-dark', light: 'subban-light' }, scheme: 'dark', themeFollowsSystem: false, userThemes: [], folderThemes: [], appearance: DEFAULT_APPEARANCE, motion: null }))
afterEach(() => cleanup())

describe('the theme cards', () => {
  it('lists every theme once, Subban picked, with both modes on each card', () => {
    mount(createElement(ThemePicker))
    const cards = screen.getAllByRole('radio').filter((r) => r.classList.contains('th-card'))
    expect(cards.map((c) => c.querySelector('.th-name > span')?.textContent)).toEqual(['Subban', 'Dracula', 'Catppuccin', 'Nord', 'One', 'Tokyo Night', 'GitHub', 'Solarized', 'Night', 'Gothic', 'Newsprint', 'Pixyll', 'Whitey'])
    expect(cards[0]?.getAttribute('aria-checked')).toBe('true')
    for (const c of cards) expect(c.querySelectorAll('.th-prev')).toHaveLength(2)
  })

  it('picking a card fills both modes; Catppuccin offers its dark flavors', () => {
    mount(createElement(ThemePicker))
    fireEvent.click(screen.getByTestId('theme-nord'))
    expect(get().themeIds).toEqual({ dark: 'nord', light: 'nord-light' })
    expect(screen.queryByRole('radiogroup', { name: 'Dark flavor' })).toBeNull()
    fireEvent.click(screen.getByTestId('theme-catppuccin'))
    expect(get().themeIds).toEqual({ dark: 'catppuccin-mocha', light: 'catppuccin-latte' })
    const flavor = screen.getByRole('radiogroup', { name: 'Dark flavor' })
    fireEvent.click(flavor.querySelector('[role=radio]:nth-child(3)') as HTMLElement)
    expect(get().themeIds.dark).toBe('catppuccin-frappe')
    expect(screen.getByTestId('theme-catppuccin').textContent).toContain('Frappe')
  })

  it('the mode switch sets light, dark or follow system', () => {
    mount(createElement(ThemeModeSeg))
    fireEvent.click(screen.getByRole('radio', { name: /Light/ }))
    expect(get()).toMatchObject({ scheme: 'light', themeFollowsSystem: false })
    fireEvent.click(screen.getByRole('radio', { name: /System/ }))
    expect(get().themeFollowsSystem).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /Dark/ }))
    expect(get()).toMatchObject({ scheme: 'dark', themeFollowsSystem: false })
  })

  it('a theme with one mode says so, and picking it while the other mode shows switches mode', () => {
    const solo = { ...(get().userThemes[0] ?? {}), version: 1 as const, id: 'paper', name: 'Paper', isDark: false, background: '#ffffff', surface: '#f4f4f4', surfaceAlt: '#ececec', border: '#d0d0d0', text: '#222222', muted: '#666666', accent: '#3355cc', ansi: Array<string>(16).fill('#555555') }
    set({ userThemes: [solo] })
    mount(createElement(ThemePicker))
    expect(screen.getByTestId('theme-paper').textContent).toContain('Light only')
    fireEvent.click(screen.getByTestId('theme-paper'))
    expect(get()).toMatchObject({ scheme: 'light', themeIds: { dark: 'subban-dark', light: 'paper' } })
    expect(familySubLabel({ id: 'x', name: 'X', dark: [solo], light: [] }, false, '')).toBe('Dark only')
  })
})

describe('accent, text and accessibility', () => {
  it('stores each choice in appearance', () => {
    mount(createElement('div', null, createElement(AccentGroup), createElement(TextGroup), createElement(AccessibilityGroup)))
    fireEvent.click(screen.getByRole('radio', { name: 'Green' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Larger' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Bold' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Higher' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Blue-yellow' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Roomy' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Reduced' }))
    expect(get().appearance).toEqual({ accent: 'green', textSize: 'larger', fontWeight: 'bold', contrast: 'higher', colorVision: 'blueyellow', density: 'roomy' })
    expect(get().motion).toBe('reduced')
    expect(screen.getByText(/Body text at 18 px/)).toBeTruthy()
  })

  it('the first-run quick options set text size, color vision and motion', () => {
    mount(createElement(EasierToRead))
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Red-green' }))
    fireEvent.click(screen.getByRole('switch'))
    expect(get().appearance).toMatchObject({ textSize: 'large', colorVision: 'redgreen' })
    expect(get().motion).toBe('reduced')
    expect(colorblindToolpaths()).toBe(true)
  })

  it('text size and weight move the type tokens together', () => {
    expect(typeVars('larger', 'bold')).toEqual({ '--text-scale': '1.29', '--fw-regular': '600', '--fw-medium': '700', '--fw-semibold': '750', '--fw-bold': '800' })
    expect(typeVars('default', 'regular')['--fw-regular']).toBe('400')
    expect([bodyPx('small'), bodyPx('default'), bodyPx('large'), bodyPx('larger')]).toEqual([13, 14, 16, 18])
  })

  it('density and accent ride on the controls preset', () => {
    const p = resolvePreset('slicerx')
    expect(withAppearance(p, 'compact', 'theme').look).toMatchObject({ density: 'compact', accent: p.look.accent })
    expect(withAppearance(p, 'comfortable', 'cyan').look).toMatchObject({ density: 'standard', accent: 'cyan' })
    expect(withAppearance(p, 'roomy', 'blue').look.density).toBe('roomy')
  })
})

describe('stored appearance', () => {
  beforeEach(() => localStorage.clear())
  it('round-trips and checks every field on its own', () => {
    savePrefs({ ...loadPrefs(), appearance: { ...DEFAULT_APPEARANCE, textSize: 'large', colorVision: 'blueyellow' } })
    expect(loadPrefs().appearance).toEqual({ ...DEFAULT_APPEARANCE, textSize: 'large', colorVision: 'blueyellow' })
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ appearance: { textSize: 'huge', contrast: 'higher', accent: 7 } }))
    expect(loadPrefs().appearance).toEqual({ ...DEFAULT_APPEARANCE, contrast: 'higher' })
  })
  it('the old toolpath palette switch becomes red-green color vision', () => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ toolpathPalette: 'colorblind' }))
    expect(loadPrefs().appearance?.colorVision).toBe('redgreen')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ toolpathPalette: 'colorblind', appearance: { colorVision: 'blueyellow' } }))
    expect(loadPrefs().appearance?.colorVision).toBe('blueyellow')
  })
  it('keeps the onboarding version and the theme step in the setup record', () => {
    const fr = { completedAt: null, step: 'theme', look: { id: 'slicerx' }, printerId: null, version: 2 }
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ firstRun: fr }))
    expect(loadPrefs().firstRun).toEqual(fr)
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ firstRun: { ...fr, version: 'x' } }))
    expect(loadPrefs().firstRun?.version).toBeUndefined()
  })
})
