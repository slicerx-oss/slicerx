// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Prints for a Bambu Lab printer with Developer Mode off, through Bambu Connect. The shell writes the file and opens
// Bambu Lab's import link (src-tauri/src/bambu_connect.rs); the webview sends bytes and a name, never a path.
import type { BambuConnectHost } from '@slicerx/contracts'
import { invoke } from '@tauri-apps/api/core'

export function createTauriBambuConnect(): BambuConnectHost {
  return {
    open: (fileName, data, title) =>
      invoke<'opened' | 'missing' | 'unsupported'>('bambu_connect_open', new Uint8Array(data), {
        headers: { 'x-sx-name': encodeURIComponent(fileName), 'x-sx-title': encodeURIComponent(title) },
      }),
  }
}
