// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the window offers that only its features know: the workspaces the top bar lists and the Settings sections the
// features add. Set by the app (app.tsx) whenever they change, and read outside React (the app link's ui.get).
import type { SettingsSectionRow } from '../shell/settings-sections'

export interface OfferedWorkspace {
  id: string
  label: string
}

let workspaces: readonly OfferedWorkspace[] = [{ id: 'prepare', label: 'Slice' }]
let featureSettings: readonly SettingsSectionRow[] = []

export function setOffered(next: { workspaces: readonly OfferedWorkspace[]; settings: readonly SettingsSectionRow[] }): void {
  workspaces = next.workspaces.map(({ id, label }) => ({ id, label }))
  featureSettings = next.settings.map(({ id, label, icon }) => ({ id, label, icon }))
}

/** The workspaces in the top bar's order. */
export function offeredWorkspaces(): readonly OfferedWorkspace[] {
  return workspaces
}

/** The Settings sections features add, before the base's own. */
export function offeredFeatureSettings(): readonly SettingsSectionRow[] {
  return featureSettings
}
