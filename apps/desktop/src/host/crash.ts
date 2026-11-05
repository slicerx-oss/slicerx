// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Crash reports the shell recorded (src-tauri/src/crash.rs): Rust panics and a web view that stopped. The
// page takes them at start, queues them as bug reports and acknowledges them, which deletes the files. After the
// shell reloaded a stopped web view (src-tauri/src/recover.rs), the page also takes what it knew then.
import type { CrashHost, NativeCrashes, ViewCrash } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'

export function createTauriCrash(): CrashHost {
  return {
    take: (pageLoad, commit) => invoke<NativeCrashes>('crash_take', { pageLoad, ...(commit ? { commit } : {}) }),
    ack: (files) => invoke('crash_ack', { files }),
    testPanic: () => invoke('crash_test_panic'),
    recovery: () => invoke<ViewCrash | null>('crash_recovery_take'),
  }
}
