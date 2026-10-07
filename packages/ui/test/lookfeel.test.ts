// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { KEYMAPS, KEY_ACTIONS, LOOK_IDS, allPresets, applyPreset, clearPreset, keymapConflicts, keymapFor, lookToVars, resolvePreset, themeNameFor } from '../src/lookfeel'

function fakeEl() {
  const props = new Map<string, string>()
  const dataset: Record<string, string> = {}
  const events: Event[] = []
  return {
    props,
    dataset,
    events,
    style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) },
    dispatchEvent: (e: Event) => (events.push(e), true),
  } as unknown as HTMLElement & { props: Map<string, string>; dataset: Record<string, string>; events: Event[] }
}

describe('look and feel presets', () => {
  it('has the four presets in the owner order, each pointing at its own controls and keymap', () => {
    expect(allPresets().map((p) => p.id)).toEqual(['slicerx', 'bambu-studio', 'prusaslicer', 'orcaslicer'])
    for (const p of allPresets()) {
      expect(p.controls).toBe(p.id)
      expect(p.keys).toBe(p.id)
    }
  })

  it('names the other slicers only as styles', () => {
    expect(resolvePreset('bambu-studio').label).toBe('Bambu Studio style')
    expect(resolvePreset('prusaslicer').label).toBe('PrusaSlicer style')
    expect(resolvePreset('orcaslicer').label).toBe('OrcaSlicer style')
  })

  it('falls back to SlicerX for an unknown id', () => {
    expect(resolvePreset('nope').id).toBe('slicerx')
  })

  it('shares one layout and one look: a style changes controls, keys and tab names only', () => {
    const own = resolvePreset('slicerx')
    for (const p of allPresets()) {
      expect(p.look).toEqual(own.look)
      expect(p.defaultTheme).toBe('subban')
      const { workspaceTabs: _t, tabLabels: _l, ...rest } = p.layout
      const { workspaceTabs: _ot, tabLabels: _ol, ...ownRest } = own.layout
      expect(rest).toEqual(ownRest)
    }
    expect(resolvePreset('prusaslicer').layout.sidebar.side).toBe('left')
    expect(resolvePreset('prusaslicer').layout.settingsModel).toBe('sidebar')
  })

  it('renames tabs per style', () => {
    expect(resolvePreset('bambu-studio').layout.tabLabels?.['printers']).toBe('Device')
    expect(resolvePreset('orcaslicer').layout.tabLabels?.['printers']).toBe('Device')
    // The first tab is Design | Slice in every look; no look renames it.
    for (const id of LOOK_IDS) expect(resolvePreset(id).layout.tabLabels?.['prepare'], id).toBeUndefined()
  })

  it('maps look values to variables', () => {
    const v = lookToVars({ density: 'compact', accent: 'orange', radius: 'sharp', rowHeight: 'sm', displayFont: false, gradientPrimary: false, iconSize: 16, iconStroke: 1.5, hairlines: 'boxes' })
    expect(v['--accent']).toBe('var(--orange)')
    expect(v['--r-sm']).toBe('4px')
    expect(v['--h-md']).toBe('28px')
    expect(v['--f-display']).toBe('var(--f-body)')
    const s = lookToVars(resolvePreset('slicerx').look)
    expect(s['--accent']).toBe('var(--purple)')
    expect(s['--h-md']).toBe('34px')
    expect(s['--f-display']).toBeUndefined()
  })

  it('applies and clears a preset with no leftovers', () => {
    const el = fakeEl()
    applyPreset({ ...resolvePreset('bambu-studio'), look: { ...resolvePreset('bambu-studio').look, gradientPrimary: false, accent: 'green', displayFont: false } }, el)
    expect(el.dataset['look']).toBe('bambu-studio')
    expect(el.dataset['gradient']).toBe('off')
    expect(el.props.get('--accent')).toBe('var(--green)')
    expect(el.props.get('--f-display')).toBe('var(--f-body)')
    applyPreset(resolvePreset('slicerx'), el)
    expect(el.props.has('--f-display')).toBe(false)
    expect(el.props.get('--accent')).toBe('var(--purple)')
    expect(el.events).toHaveLength(2)
    clearPreset(el)
    expect(el.props.size).toBe(0)
    expect(el.dataset['look']).toBeUndefined()
  })

  it('starts every style dark; only a system default follows the OS', () => {
    expect(themeNameFor(resolvePreset('slicerx'), false)).toBe('subban')
    expect(themeNameFor(resolvePreset('orcaslicer'), false)).toBe('subban')
    // a stored preset from before the rename still says nocturne
    expect(themeNameFor({ ...resolvePreset('orcaslicer'), defaultTheme: 'nocturne' }, false)).toBe('subban')
    expect(themeNameFor({ ...resolvePreset('orcaslicer'), defaultTheme: 'system' }, false)).toBe('subban-light')
    expect(themeNameFor({ ...resolvePreset('orcaslicer'), defaultTheme: 'system' }, true)).toBe('subban')
  })
})

describe('keymaps', () => {
  it('defines every action for every look', () => {
    for (const id of LOOK_IDS) for (const a of KEY_ACTIONS) expect(a in KEYMAPS[id], `${id} ${a}`).toBe(true)
  })

  it('has no chord bound twice inside one look', () => {
    for (const id of LOOK_IDS) expect(keymapConflicts(KEYMAPS[id]), id).toEqual([])
    // Design | Slice is Mod+E in all four looks (Tab is Preview in three of them; sketching takes bare digits).
    for (const id of LOOK_IDS) expect(KEYMAPS[id]['model.mode'], id).toBe('Mod+E')
  })

  it('matches the research on the disputed keys', () => {
    expect(KEYMAPS['prusaslicer']['view.iso']).toBe('0')
    expect(KEYMAPS['bambu-studio']['view.plate']).toBe('0')
    expect(KEYMAPS['bambu-studio'].slice).toBe('Mod+G')
    expect(KEYMAPS['prusaslicer'].slice).toBe('Mod+R')
    expect(KEYMAPS['prusaslicer'].export).toBe('Mod+G')
    expect(KEYMAPS['orcaslicer']['view.top']).toBe('Mod+1')
    expect(KEYMAPS['slicerx']['view.zoomSelection']).toBe('Z')
    expect(KEYMAPS['orcaslicer']['view.zoomSelection']).toBeNull()
  })

  it('applies user overrides and clears with an empty string', () => {
    const m = keymapFor('slicerx', { 'tool.cut': 'X', 'tool.move': '' })
    expect(m['tool.cut']).toBe('X')
    expect(m['tool.move']).toBeNull()
    expect(keymapFor('slicerx')['tool.cut']).toBe('C')
  })
})
