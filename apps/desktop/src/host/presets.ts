// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// First run: the user presets of an installed OrcaSlicer, Bambu Studio or PrusaSlicer, listed and read by the
// shell (src-tauri/src/presets.rs). The webview names a slicer, never a path of its own.
import type { PresetImportHost } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'

export function createTauriPresetImport(): PresetImportHost {
  return {
    scan: (app) => invoke('presets_scan', { slicer: app }),
    read: (preset) => invoke<string>('presets_read', { path: preset.path }),
  }
}
