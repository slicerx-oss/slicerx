// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings mode selector the look and feel places: Simple, Advanced, Expert and Developer as a
// segmented control, or a single Advanced switch where the preset has only two modes. Simple hides the expert settings.
import type { LayoutSpec } from '@slicerx/contracts'
import { Seg, Switch } from '@slicerx/ui'
import { set, useApp, type SettingsMode } from '../state/store'
import { effectiveMode } from './look'

const LABEL: Record<SettingsMode, string> = { simple: 'Simple', advanced: 'Advanced', expert: 'Expert', developer: 'Developer' }
const TIP: Partial<Record<SettingsMode, string>> = { developer: 'Developer: shows setting keys and adds the developer commands and tools, such as a test crash' }

export function ModeSelector({ layout, id }: { layout: LayoutSpec; id: string }) {
  const stored = useApp((s) => s.settingsMode)
  const mode = effectiveMode(stored, layout)
  if (layout.modes.length <= 2) {
    return (
      <span className="mode-switch">
        <label htmlFor={id}>Advanced</label>
        <Switch id={id} label="Advanced" checked={mode !== 'simple'} onChange={(v) => set({ settingsMode: v ? 'advanced' : 'simple' })} />
      </span>
    )
  }
  return <Seg label="Settings mode" size="sm" value={mode} options={layout.modes.map((m) => ({ value: m, label: LABEL[m], ...(TIP[m] ? { title: TIP[m] } : {}) }))} onChange={(v) => set({ settingsMode: v })} className="mode-seg" />
}

/** True when the expert settings block shows. */
export function useExpertVisible(layout: LayoutSpec): boolean {
  const stored = useApp((s) => s.settingsMode)
  const open = useApp((s) => s.expertOpen)
  // a layout with Simple alone (a phone) never shows them, whatever was left open
  if (!layout.modes.some((m) => m !== 'simple')) return false
  return effectiveMode(stored, layout) !== 'simple' || open
}
