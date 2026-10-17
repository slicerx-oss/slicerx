// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print settings in Advanced and Expert sit behind tabs, one per group (moved from the settings-tabs Playwright
// spec, state and ARIA only; the sticky tab row and the fold positions are measured in a real layout, in the sidebar
// journey). Color shows only with two or more filaments and holds the prime tower row; a search looks through every
// tab; arrows move between tabs; a changed Expert setting stays listed in Advanced; sections fold to a summary; pins,
// the open tab and the sections are remembered; a plate row shows the objects that print it with their own value.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { normalizePrefs } from '../src/state/prefs'
import { get, set, type PlateEntry } from '../src/state/store'

const filaments = vi.hoisted(() => ({ n: 2 }))
vi.mock('../src/filament/count', () => ({ useFilamentCount: () => filaments.n }))

const { ExpertSettings } = await import('../src/workspaces/prepare/expert-settings')

const TABS = ['Quality', 'Strength', 'Speed', 'Supports', 'Adhesion', 'Color', 'Surface', 'Output and print order']

beforeEach(() => {
  filaments.n = 2
  set({ settingsMode: 'advanced', settingsTab: 'quality', settingsSections: {}, settingsPins: [], overrides: {}, objectSettings: {}, plate: [], selection: null, selectedIds: [] })
})

afterEach(() => {
  cleanup()
  set({ settingsMode: 'advanced', settingsTab: 'quality', settingsSections: {}, settingsPins: [], overrides: {}, objectSettings: {}, plate: [], selection: null, selectedIds: [] })
})

// Hidden while a search lists every tab, so not by role.
const tablist = () => document.querySelector<HTMLElement>('[role="tablist"][aria-label="Setting groups"]')!
const tabs = () => [...tablist().querySelectorAll<HTMLElement>('[role="tab"]')]
const tab = (id: string) => screen.getByTestId(`slice-settings-tab-${id}`)
const selected = () => tabs().filter((t) => t.getAttribute('aria-selected') === 'true')
const panel = () => document.getElementById('set-tab-panel')!
const header = (key: string) => document.querySelector<HTMLElement>(`[data-testid="slice-settings-section"][data-section="${key}"]`)!
const mount = () => render(createElement(ExpertSettings))
const press = (el: Element, key: string) => act(() => void fireEvent.keyDown(el, { key }))
const click = (el: Element) => act(() => void fireEvent.click(el))
const search = (text: string) => act(() => void fireEvent.change(document.getElementById('expert-search')!, { target: { value: text } }))

describe('the tabs', () => {
  it('are one per group; Color shows with two filaments and holds the prime tower row', () => {
    mount()
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(TABS)
    expect(selected().map((t) => t.getAttribute('data-tab'))).toEqual(['quality'])
    expect(panel().querySelectorAll('.tier-group')).toHaveLength(1)
    expect(screen.queryByTestId('slice-tower-atlas')).toBeNull()
    act(() => set({ overrides: { enable_prime_tower: true } }))
    click(tab('multicolor'))
    expect(tab('multicolor').getAttribute('aria-selected')).toBe('true')
    // One prime tower switch, first in the Color section, with atlas's placement under it.
    const color = panel().querySelector('section[aria-label="Color"]')!
    expect(color.querySelectorAll('#set-enable_prime_tower')).toHaveLength(1)
    // atlas places the tower: no second switch for automatic placement.
    expect(screen.queryByRole('switch', { name: /automatically/i })).toBeNull()
    expect(color.querySelector('ul > li')?.className).toMatch(/tower-row/)
    expect(color.querySelector('[data-testid="slice-tower-atlas"]')?.textContent).toContain('atlas places it')
  })

  it('leave out Color for one filament, and an open Color tab falls back to Quality', () => {
    mount()
    click(tab('multicolor'))
    expect(tab('multicolor').getAttribute('aria-selected')).toBe('true')
    filaments.n = 1
    cleanup()
    mount()
    expect(screen.queryByTestId('slice-settings-tab-multicolor')).toBeNull()
    expect(tabs().map((t) => t.getAttribute('aria-label'))).not.toContain('Color')
    expect(tab('quality').getAttribute('aria-selected')).toBe('true')
  })

  it('move with the arrows, Home and End, and a search lists matches from every group with no tab picked', () => {
    mount()
    tab('quality').focus()
    press(tab('quality'), 'ArrowRight')
    expect(tab('strength').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('strength'))
    press(tab('strength'), 'End')
    expect(tab('output').getAttribute('aria-selected')).toBe('true')
    press(tab('output'), 'ArrowRight')
    expect(tab('quality').getAttribute('aria-selected')).toBe('true')
    press(tab('quality'), 'ArrowLeft')
    expect(tab('output').getAttribute('aria-selected')).toBe('true')
    press(tab('output'), 'Home')
    expect(tab('quality').getAttribute('aria-selected')).toBe('true')
    search('wall')
    expect(panel().querySelectorAll('.tier-group').length).toBeGreaterThan(1)
    expect(selected()).toHaveLength(0)
  })

  it('count their changes, and a section with a change says so in its header', () => {
    set({ overrides: { seam_position: 'back' } })
    mount()
    expect(tab('quality').querySelector('[data-testid="slice-settings-tab-count"]')?.textContent).toBe('1')
    expect(tab('strength').querySelector('[data-testid="slice-settings-tab-count"]')).toBeNull()
    // The first section with rows starts open; the others show a summary of their values, a changed row stays listed.
    expect(header('quality/layers').getAttribute('aria-expanded')).toBe('true')
    expect(header('quality/seam').getAttribute('aria-expanded')).toBe('false')
    expect(header('quality/seam').textContent).toContain('1 changed')
    expect(document.getElementById('set-seam_position')).not.toBeNull()
    click(header('quality/walls'))
    expect(header('quality/walls').getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('#set-wall_generator, [data-key="wall_generator"]')).not.toBeNull()
    click(header('quality/walls'))
    expect(header('quality/walls').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('Expert and Advanced', () => {
  it('head Output with print sequence in Expert, and a search finds it there only', () => {
    set({ settingsMode: 'expert' })
    mount()
    click(tab('output'))
    const output = () => panel().querySelector('section[aria-label="Output and print order"]')
    expect(output()!.querySelector('ul > li')!.querySelector('#set-print_sequence')).not.toBeNull()
    search('print sequence')
    expect(panel().querySelector('section[aria-label="Output and print order"] #set-print_sequence')).not.toBeNull()
    expect(panel().querySelector('section[aria-label="Surface"] #set-print_sequence')).toBeNull()
  })

  it('keep a setting changed in Expert listed after a switch to Advanced, under the Expert divider', () => {
    set({ settingsMode: 'expert', overrides: { detect_thin_wall: true } })
    const view = mount()
    const walls = () => view.container.querySelector<HTMLElement>('.pset-sec[data-section="quality/walls"]')!
    click(header('quality/walls'))
    expect(walls().querySelector('#set-detect_thin_wall')).not.toBeNull()
    act(() => set({ settingsMode: 'advanced' }))
    const row = () => walls().querySelector('li:has(#set-detect_thin_wall)')!
    expect(row().className).toMatch(/changed/)
    // After the Advanced rows and the divider; nothing else from Expert, and no "more" to open.
    const order = [...walls().querySelectorAll('ul > li')].map((e) => (e.classList.contains('tier-divider') ? 'divider' : e.querySelector('#set-detect_thin_wall') ? 'changed' : 'row'))
    expect(order.filter((x) => x !== 'row')).toEqual(['divider', 'changed'])
    expect(order.at(-1)).toBe('changed')
    expect(panel().querySelector('.tier-more')).toBeNull()
    // Folded, the section still lists the change; an Expert setting left alone stays out.
    click(header('quality/walls'))
    expect(header('quality/walls').getAttribute('aria-expanded')).toBe('false')
    expect(walls().querySelector('#set-detect_thin_wall')).not.toBeNull()
    expect(walls().querySelector('#set-wall_sequence')).toBeNull()
    expect(document.getElementById('set-precise_z_height')).toBeNull()
  })
})

describe('pins, search and the Changed list', () => {
  it('pin a setting at the top, find a setting by what it fixes, and list only edits from every tab', () => {
    set({ settingsTab: 'supports' })
    mount()
    click(header('supports/touch'))
    const row = () => panel().querySelector<HTMLElement>('li[data-key="support_top_z_distance"]')!
    const pin = () => row().querySelector<HTMLElement>('[data-testid="slice-setting-pin"]')!
    expect(pin().getAttribute('aria-pressed')).toBe('false')
    click(pin())
    expect(pin().getAttribute('aria-pressed')).toBe('true')
    expect(get().settingsPins).toEqual(['support_top_z_distance'])
    expect(screen.getByTestId('slice-settings-pins').querySelectorAll('#pin-support_top_z_distance')).toHaveLength(1)
    // A print problem finds the settings that help with it, and says why.
    search('stringing')
    const travel = panel().querySelector('li[data-key="travel_speed"]')
    expect(travel).not.toBeNull()
    expect(travel!.textContent).toContain('Helps with stringing')
    search('')
    expect(tab('supports').getAttribute('aria-selected')).toBe('true')
    // Changed lists only edits, from every tab, and a second press goes back.
    act(() => set({ overrides: { support_top_z_distance: 0.3 } }))
    click(screen.getByTestId('slice-settings-changed'))
    expect(panel().querySelectorAll('li[data-testid="slice-setting-row"]')).toHaveLength(1)
    click(screen.getByTestId('slice-settings-changed'))
    expect(tab('supports').getAttribute('aria-selected')).toBe('true')
  })

  it('come back with the open tab, the open sections and the pins', () => {
    const back = normalizePrefs({ settingsTab: 'supports', settingsSections: { 'supports/touch': true }, settingsPins: ['support_top_z_distance'] })
    expect(back.settingsTab).toBe('supports')
    expect(back.settingsSections).toEqual({ 'supports/touch': true })
    expect(back.settingsPins).toEqual(['support_top_z_distance'])
    set({ settingsTab: 'supports', settingsSections: { 'supports/touch': true }, settingsPins: ['support_top_z_distance'] })
    mount()
    expect(tab('supports').getAttribute('aria-selected')).toBe('true')
    expect(header('supports/touch').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('slice-settings-pins').querySelectorAll('#pin-support_top_z_distance')).toHaveLength(1)
  })
})

describe('a plate row', () => {
  it('shows the objects that print it with their own value, and a chip selects the object', () => {
    const entry: PlateEntry = { id: 'o1', name: 'Cube', handle: { id: 'o1', hash: 'o1', name: 'Cube', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] }, parts: [{ ...boxMesh(20, 20, 20), name: 'Cube' }], colors: ['#bd93f9'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
    set({ plate: [entry], objectSettings: { o1: { top_shell_layers: 7 } }, settingsTab: 'strength' })
    mount()
    const chip = document.querySelector('li[data-key="top_shell_layers"] [data-testid="slice-setting-object-chip"]')!
    expect(chip.textContent).toContain('Cube')
    expect(chip.textContent).toContain('7')
    click(chip)
    expect(get().selectedIds).toEqual(['o1'])
  })
})
