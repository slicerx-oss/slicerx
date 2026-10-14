// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print settings as tabs of named sections: every key has a section, Advanced is the short set, the first section
// with rows opens by default, a search reaches a setting by the problem it helps with, and an agent arranges the panel
// through the bridge and reads it back.
import { afterEach, describe, expect, it } from 'vitest'
import { setSettingsView } from '../src/agent-bridge/settings'
import { appState } from '../src/agent-bridge/page'
import { SECTIONS, sectionOf } from '../src/workspaces/prepare/setting-sections'
import { fixMatch } from '../src/workspaces/prepare/setting-fixes'
import { buildTabs, EDITABLE_PROCESS, sectionHasRows, sectionOpen, sectionRows } from '../src/workspaces/prepare/settings-view'
import { get, set } from '../src/state/store'

afterEach(() => set({ overrides: {}, settingsMode: 'advanced', settingsTab: 'quality', settingsSections: {}, settingsPins: [] }))

const none = () => false

describe('settings sections', () => {
  it('gives every process key a section of its tab, and every section a label', () => {
    for (const d of EDITABLE_PROCESS) {
      if (!d.intent) continue
      const sec = sectionOf(d.intent, d.key)
      expect(SECTIONS[d.intent]).toContain(sec)
    }
    for (const list of Object.values(SECTIONS)) expect(list.filter((s) => !s.match)).toHaveLength(1)
  })

  it('lists the short Advanced set: 42 keys and the two overhang choices', () => {
    const tabs = buildTabs({ mode: 'advanced', changed: none, filamentCount: 2, searching: false })
    const shown = tabs.flatMap((t) => t.sections.flatMap((s) => s.shown))
    expect(shown).toHaveLength(42)
    expect(tabs[0]!.sections.find((s) => s.id === 'overhangs')!.choices).toBe(true)
    // nothing above Advanced is listed until it changes
    expect(tabs.flatMap((t) => t.sections.flatMap((s) => sectionRows(s, { mode: 'advanced', changed: none, moreOpen: true }).more))).toHaveLength(0)
    expect(shown.map((d) => d.key)).toEqual(expect.arrayContaining(['top_shell_layers', 'bottom_shell_layers', 'print_sequence']))
  })

  it('keeps a changed Expert setting listed in Advanced, in its own section', () => {
    const changed = (k: string) => k === 'seam_slope_type'
    const tabs = buildTabs({ mode: 'advanced', changed, filamentCount: 1, searching: false })
    const seam = tabs[0]!.sections.find((s) => s.id === 'seam')!
    expect(sectionRows(seam, { mode: 'advanced', changed, moreOpen: false }).more.map((d) => d.key)).toEqual(['seam_slope_type'])
  })

  it('in Expert, puts the rest behind "more" per section', () => {
    const tabs = buildTabs({ mode: 'expert', changed: none, filamentCount: 1, searching: false })
    const seam = tabs[0]!.sections.find((s) => s.id === 'seam')!
    const closed = sectionRows(seam, { mode: 'expert', changed: none, moreOpen: false })
    expect(closed.more).toHaveLength(0)
    expect(closed.hidden).toBeGreaterThan(5)
    expect(sectionRows(seam, { mode: 'expert', changed: none, moreOpen: true }).more).toHaveLength(closed.hidden)
  })

  it('opens the first section with rows by default, and a section set by hand stays as set', () => {
    const o = { mode: 'advanced' as const, changed: none }
    const tabs = buildTabs({ ...o, filamentCount: 1, searching: false })
    const strength = tabs.find((t) => t.intent.id === 'strength')!
    const withRows = strength.sections.filter((s) => sectionHasRows(s, o))
    // wall loops is an Easy control, so Strength starts at its shells
    expect(withRows[0]!.id).toBe('shells')
    expect(sectionOpen({}, strength, withRows[0]!, o)).toBe(true)
    expect(sectionOpen({}, strength, withRows[1]!, o)).toBe(false)
    expect(sectionOpen({ 'strength/shells': false }, strength, withRows[0]!, o)).toBe(false)
  })
})

describe('search by what a setting fixes', () => {
  it('finds settings by a print problem', () => {
    expect(fixMatch('travel_speed', 'stringing')).toBe('stringing')
    expect(fixMatch('elefant_foot_compensation', 'elephant')).toBe('elephant foot')
    expect(fixMatch('brim_width', 'warp')).toBe('warping')
    expect(fixMatch('brim_width', 'stringing')).toBeNull()
    expect(fixMatch('travel_speed', 'st')).toBeNull()
  })
})

describe('the settings panel through the agent bridge', () => {
  it('opens a tab and sections and pins settings, and app_state reads it back', () => {
    set({ settingsMode: 'advanced', overrides: { support_top_z_distance: 0.25 } })
    const view = setSettingsView({ tab: 'supports', open: ['touch'], close: ['Where supports go'], pin: ['seam_position', 'Brim width'] })
    expect(view).toMatchObject({ tab: 'supports', pins: [{ key: 'seam_position' }, { key: 'brim_width' }] })
    expect(view['sections']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'where', open: false }),
        expect.objectContaining({ id: 'touch', open: true, changed: ['support_top_z_distance'] }),
      ]),
    )
    expect((view['tabs'] as { id: string; changed: number }[]).find((t) => t.id === 'supports')!.changed).toBe(1)
    expect(get().settingsSections).toEqual({ 'supports/touch': true, 'supports/where': false })
    expect(appState(get())['settings']).toEqual(view)
    expect(setSettingsView({ unpin: ['seam_position'] })['pins']).toEqual([{ key: 'brim_width', label: 'Brim width' }])
  })

  it('refuses a tab, section or setting that does not exist', () => {
    expect(() => setSettingsView({ tab: 'nope' })).toThrow(/no tab/)
    expect(() => setSettingsView({ tab: 'quality', open: ['nope'] })).toThrow(/no section/)
    expect(() => setSettingsView({ pin: ['not_a_key'] })).toThrow(/no print setting/)
    expect(() => setSettingsView({ open: 'walls' })).toThrow(/list/)
  })
})
