// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pairing host's sealed document, kept by the shell (src-tauri/src/pairdoc.rs): encrypted in the app data
// folder, with the key in the system keychain.
import type { DocStore } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'

export function tauriDocStore(): DocStore {
  return {
    read: () => invoke<string | null>('pair_doc_read'),
    write: (text) => invoke<void>('pair_doc_write', { text }),
  }
}
