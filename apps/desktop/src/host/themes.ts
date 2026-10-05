// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The themes folder in the app data directory. Rust owns the path; the webview gets file text only.
import type { ThemesHost } from '@slicerx/contracts'
import { invoke } from '@tauri-apps/api/core'

export function createTauriThemes(): ThemesHost {
  return {
    list: () => invoke<string[]>('themes_list'),
    openFolder: () => invoke<void>('themes_open_folder'),
  }
}
