// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shell's copy of the prefs (src-tauri/src/prefs.rs). One write in flight at a time; a change made while one is
// in flight is sent when it finishes, latest only, so dragging a pane edge does not queue a write per frame.
import { invoke } from '@tauri-apps/api/core'

export function prefsWriter(send: (json: string) => Promise<unknown> = (json) => invoke('prefs_save', { json })): (json: string) => void {
  let busy = false
  let next: string | null = null
  const write = (json: string) => {
    busy = true
    void send(json)
      .catch(() => undefined)
      .finally(() => {
        busy = false
        const n = next
        next = null
        if (n !== null) write(n)
      })
  }
  return (json) => {
    if (busy) next = json
    else write(json)
  }
}
