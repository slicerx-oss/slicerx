// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The themes folder in the app data directory. Rust owns the path; the webview gets file text only.
import type { Host, ThemesHost } from '@slicerx/contracts'
import { invoke } from './invoke'

export function createTauriThemes(): ThemesHost {
  return {
    list: () => invoke<string[]>('themes_list'),
    openFolder: () => invoke<void>('themes_open_folder'),
  }
}

/** The license files the installed app carries (src-tauri/src/licenses.rs), which About opens. */
export function createTauriLicenses(): NonNullable<Host['licenses']> {
  return { openFolder: () => invoke<void>('licenses_open_folder') }
}
