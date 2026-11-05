// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D mouse in the desktop app: the shell reads the device (src-tauri/src/spacemouse.rs) and sends each raw input
// report and every status change; the app parses them as it does WebHID's (packages/app/src/viewport/spacemouse.ts).
import type { SpaceMouseSource, SpaceMouseStatus } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** The shell's status as the setting reads it; an unknown one reads as an error. */
export function statusOf(p: unknown): SpaceMouseStatus {
  const r = (p ?? {}) as { state?: unknown; name?: unknown; message?: unknown }
  const name = typeof r.name === 'string' && r.name ? r.name : '3D mouse'
  switch (r.state) {
    case 'none':
      return { state: 'none' }
    case 'connected':
      return { state: 'connected', name }
    case 'busy':
      return { state: 'busy', name }
    default:
      return { state: 'error', message: typeof r.message === 'string' && r.message ? r.message : "Can't read the 3D mouse." }
  }
}

export function createTauriSpaceMouse(): SpaceMouseSource {
  // A reload leaves the shell's reader running from the page before: stop it as this page loads, so the device stays
  // open only while this page's setting asks for it. Every start waits for this.
  const released = invoke('spacemouse_stop').catch(() => {})
  return {
    kind: 'desktop',
    start(onReport, onStatus) {
      let stopped = false
      let offs: UnlistenFn[] = []
      onStatus({ state: 'none' })
      // listening first, so the reader's first status is not missed
      void Promise.all([listen<number[]>('sx-spacemouse-report', (e) => onReport(Uint8Array.from(e.payload))), listen<unknown>('sx-spacemouse-status', (e) => onStatus(statusOf(e.payload)))])
        .then(async (list) => {
          await released
          if (stopped) return list.forEach((off) => off())
          offs = list
          return invoke('spacemouse_start')
        })
        .catch((e: unknown) => onStatus({ state: 'error', message: String(e) }))
      return () => {
        stopped = true
        for (const off of offs) off()
        offs = []
        void invoke('spacemouse_stop').catch(() => {})
      }
    },
  }
}
