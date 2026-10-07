// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// In-app updates through the shell (src-tauri/src/updates.rs): the page decides when to check and asks before the
// restart; Rust fetches, checks the signature against the edition's update key, installs and restarts.
import type { FoundUpdate, UpdaterHost } from '@slicerx/app'
import { Channel, invoke } from '@tauri-apps/api/core'

/** How this install takes updates, or null when the build has no update feed. */
export async function updaterMode(): Promise<UpdaterHost['mode'] | null> {
  const mode = await invoke<string>('update_mode').catch(() => 'off')
  return mode === 'install' || mode === 'download' ? mode : null
}

export function createTauriUpdater(mode: UpdaterHost['mode']): UpdaterHost {
  return {
    mode,
    check: () => invoke<FoundUpdate | null>('update_check'),
    download: (onProgress) => {
      const progress = new Channel<{ got: number; total: number | null }>()
      progress.onmessage = (p) => onProgress(p.got, p.total)
      return invoke<void>('update_download', { onProgress: progress })
    },
    restart: () => invoke<void>('update_restart'),
    quit: () => invoke<void>('quit_app'),
  }
}
