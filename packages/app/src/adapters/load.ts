// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings schema and its helpers are about 55 KB gzip, so the startup chunk does not carry them. Code that needs them
// from the startup path asks here; the schema loads on first use (the Prepare workspace, slicing, the command bar).
export type SettingsApi = typeof import('./settings')

let loaded: SettingsApi | null = null
let pending: Promise<SettingsApi> | null = null

export function loadSettings(): Promise<SettingsApi> {
  pending ??= import('./settings').then((m) => (loaded = m))
  return pending
}

/** The settings api when it has loaded, else null. */
export function settingsIfLoaded(): SettingsApi | null {
  return loaded
}
