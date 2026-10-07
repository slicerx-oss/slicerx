// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The setup preview: what each look shows and labels, read from the app's own data.
import { LOOK_IDS, type LookId } from '@slicerx/contracts'
import { keymapFor, resolvePreset } from '@slicerx/ui'
import { controlsPreset } from '@slicerx/viewport'
import { describe, expect, it } from 'vitest'
import { topBarTabs } from '../src/first-run/look'
import { lookPreview, mouseLine, previewTabs, sidebarSections } from '../src/first-run/look-preview'
import { cardLine } from '../src/first-run/slicer-step'

const ws = [
  { id: 'prepare', label: 'Prepare', icon: 'prepare' as const, component: null },
  { id: 'preview', label: 'Preview', icon: 'preview' as const, component: null },
  { id: 'library', label: 'Vault', icon: 'library' as const, component: null },
  { id: 'printers', label: 'Printers', icon: 'printer' as const, component: null },
]
const fmt = (c: string) => c
const preview = (id: LookId, keys: Record<string, string> = {}) => lookPreview(id, ws, controlsPreset, fmt, keys)

describe('setup preview', () => {
  it('labels the three things that matter most for each look', () => {
    expect(preview('bambu-studio').notes.map((n) => n.id)).toEqual(['tabs', 'slice', 'scroll'])
    expect(preview('orcaslicer').notes.map((n) => n.id)).toEqual(['tabs', 'palette', 'slice'])
    expect(preview('prusaslicer').notes.map((n) => n.id)).toEqual(['tabs', 'slice', 'scroll'])
    // The SlicerX defaults name what is their own: no other look has these.
    expect(preview('slicerx').notes.map((n) => n.id)).toEqual(['slice', 'scroll', 'space-pan'])
  })

  it('says what changed in plain words, with the real keys', () => {
    const bambu = preview('bambu-studio')
    expect(bambu.notes[0]).toMatchObject({ title: 'Printers is named Device', tab: 'printers', target: 'tab', detail: 'As in Bambu Studio, right after Preview.' })
    expect(bambu.notes[1]).toMatchObject({ title: 'Mod+G slices the plate', target: 'slice' })
    expect(bambu.notes[2]).toMatchObject({ title: 'Two-finger scroll zooms', target: 'plate' })
    const orca = preview('orcaslicer')
    expect(orca.notes[1]).toMatchObject({ title: 'Space opens the command bar', target: 'search' })
    expect(orca.palette).toBe('Space')
    const prusa = preview('prusaslicer')
    expect(prusa.notes[0]).toMatchObject({ title: 'Prepare is named Plater', detail: 'As in PrusaSlicer, the first tab.' })
    expect(prusa.notes[1]?.detail).toBe('Mod+G exports the G-code.')
    expect(prusa.more).toContain('0 shows the iso view')
    expect(preview('slicerx').notes[0]?.title).toBe('Mod+Enter slices the plate')
  })

  it('shows only true differences: nothing the look shares with the SlicerX defaults', () => {
    for (const id of LOOK_IDS) {
      if (id === 'slicerx') continue
      const ids = [...preview(id).notes.map((n) => n.id)]
      // Bambu Studio and PrusaSlicer open the command bar with Mod+K, like the defaults.
      if (keymapFor(id).palette === keymapFor('slicerx').palette) expect(ids).not.toContain('palette')
    }
    // PrusaSlicer leaves support painting without a key: no note promises one.
    expect(preview('prusaslicer').more.join(' ')).not.toMatch(/supports/)
  })

  it('draws the window from the app data: tabs, sidebar, modes, tools and their keys', () => {
    for (const id of LOOK_IDS) {
      const p = preview(id)
      const layout = resolvePreset(id).layout
      expect(p.tabs.map((t) => t.label)).toEqual(topBarTabs(ws, layout).map((w) => w.label))
      expect(p.sidebar).toEqual(sidebarSections(layout))
      expect(p.modes).toEqual([...layout.modes])
      expect(p.slice).toBe(keymapFor(id).slice)
    }
    expect(preview('bambu-studio').tabs.map((t) => t.label)).toEqual(['Prepare', 'Preview', 'Device', 'Vault'])
    expect(preview('prusaslicer').tabs.find((t) => t.renamed)?.label).toBe('Plater')
    expect(preview('slicerx').tabs.some((t) => t.renamed)).toBe(false)
    expect(preview('slicerx').sidebar).toEqual(['Printer', 'Filament', 'Objects', 'Print settings'])
    const paint = (id: LookId) => preview(id).tools.find((t) => t.label === 'Paint')?.key
    expect([paint('bambu-studio'), paint('orcaslicer'), paint('prusaslicer')]).toEqual(['I', 'L', null])
  })

  it('keeps one Library tab when the build has the community feed', () => {
    const withFeed = [...ws, { id: 'feed', label: 'Vault', icon: 'feed' as const, component: null }]
    expect(previewTabs('bambu-studio', withFeed).filter((t) => t.label === 'Vault')).toHaveLength(1)
  })

  it("follows the person's own keys", () => {
    const p = preview('bambu-studio', { slice: 'Mod+Shift+S' })
    expect(p.slice).toBe('Mod+Shift+S')
    expect(p.notes.find((n) => n.id === 'slice')?.title).toBe('Mod+Shift+S slices the plate')
  })

  it('writes card lines and the mouse line from the same notes and map', () => {
    expect(cardLine(preview('bambu-studio'))).toBe('Device tab, Mod+G to slice')
    expect(cardLine(preview('orcaslicer'))).toBe('Device tab, Space for commands')
    expect(cardLine(preview('prusaslicer'))).toBe('Plater tab, Mod+R to slice')
    expect(cardLine(preview('slicerx'))).toBe('Start with the SlicerX defaults')
    expect(mouseLine(controlsPreset('bambu-studio'))).toBe('Left drag rotates, right or middle drag pans')
  })

  it('keeps copy plain: no dashes, no internal keys, short enough for the window', () => {
    for (const id of LOOK_IDS) {
      const p = preview(id)
      for (const n of p.notes) {
        for (const text of [n.title, n.detail, n.short]) {
          expect(text).not.toMatch(/[\u2013\u2014]/)
          expect(text).not.toMatch(/\b(tool|view|preview|edit)\.[a-z]/i)
          expect(text).not.toMatch(/_/)
        }
        expect(n.title.length).toBeLessThanOrEqual(40)
        expect(n.short.length).toBeLessThanOrEqual(30)
      }
      expect(p.notes.length).toBeGreaterThanOrEqual(2)
      expect(p.notes.length).toBeLessThanOrEqual(3)
    }
  })
})
