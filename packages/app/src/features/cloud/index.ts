// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature `cloud`: commands to slice on the edition's cloud service or on this
// device. The app entry routes Host.slicer through `cloudSlicing()`.
import type { AppFeature } from '@slicerx/contracts'
import { setSliceNote, toast } from '@slicerx/app'

const KEY = 'slicerx.cloud-slicing'
let on = false
try {
  on = localStorage.getItem(KEY) === '1'
} catch {
  // Storage can be blocked; the choice then lasts for this session only.
}

/** Whether the user chose cloud slicing. Read on every slice. */
export function cloudSlicing(): boolean {
  return on
}

const NOTE = 'Slices in the cloud on your account.'

function choose(next: boolean): void {
  on = next
  setSliceNote(next ? NOTE : null)
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
    // See above: the choice still applies until the page closes.
  }
  toast(next ? 'Slicing in the cloud from now on' : 'Slicing on this device from now on', 'info')
}

export const cloudFeature: AppFeature = {
  id: 'cloud',
  requires: ['cloud'],
  commands: () => {
    // Restore the note for a choice made in an earlier session.
    setSliceNote(on ? NOTE : null)
    return [
    { id: 'cloud-slicing-on', title: 'Slice in the cloud', section: 'slice', keywords: ['remote', 'server', 'online'], enabled: () => !on, run: () => choose(true) },
      { id: 'cloud-slicing-off', title: 'Slice on this device', section: 'slice', keywords: ['local', 'offline'], enabled: () => on, run: () => choose(false) },
    ]
  },
}
