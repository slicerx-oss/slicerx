// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Crash reports the shell recorded (src-tauri/src/crash.rs): Rust panics and a web view that stopped. The
// page takes them at start, queues them as bug reports and acknowledges them, which deletes the files. After the
// shell reloaded a stopped web view (src-tauri/src/recover.rs), the page also takes what it knew then.
import type { CrashHost, NativeCrashes, RunsFrom, ViewCrash } from '@slicerx/app'
import { resourceDir } from '@tauri-apps/api/path'
import { invoke, lastFailedCommand } from './invoke'

/**
 * Where the app runs from, by the folder of its resources, as a coarse label with no path: the Applications folder, a
 * mounted disk image (/Volumes), a copy macOS moved aside on first open (App Translocation), or elsewhere.
 */
export function runsFromOf(dir: string): RunsFrom {
  if (dir.startsWith('/Applications/')) return 'Applications folder'
  if (dir.startsWith('/Volumes/')) return 'disk image'
  if (dir.includes('/AppTranslocation/')) return 'elsewhere (moved by macOS on first open)'
  return 'elsewhere'
}

/** `resources` finds the app's resources folder; the shell's path resolver fails when the bundle moved or was ejected. */
export function createTauriCrash(resources: () => Promise<string> = resourceDir): CrashHost {
  return {
    take: (pageLoad, commit) => invoke<NativeCrashes>('crash_take', { pageLoad, ...(commit ? { commit } : {}) }),
    ack: (files) => invoke('crash_ack', { files }),
    testPanic: () => invoke('crash_test_panic'),
    recovery: () => invoke<ViewCrash | null>('crash_recovery_take'),
    lastFailedCommand,
    runsFrom: () => resources().then(runsFromOf, () => 'its resources are missing (moved or ejected while it ran)' as const),
  }
}
