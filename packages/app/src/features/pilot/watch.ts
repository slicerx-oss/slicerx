// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the hub watches, for the dot in the top bar and the dock. Tiny on purpose: the top bar is in the shell chunk.

export interface Watch {
  /** Printers the hub is watching through their camera. */
  names: string[]
  /** True when a detector found something in the last minutes and the person should look. */
  attention: boolean
}

/** What the hub says it watches (PrinterStatus.watch). A host without the field counts a printing printer with a camera. */
export function watchOf(rows: readonly { name: string; status: { state: string; cameraAvailable: boolean; watch?: 'off' | 'watching' | 'attention' } }[]): Watch {
  const names: string[] = []
  let attention = false
  for (const r of rows) {
    const w = r.status.watch ?? (r.status.state === 'printing' && r.status.cameraAvailable ? 'watching' : 'off')
    if (w === 'off') continue
    names.push(r.name)
    if (w === 'attention') attention = true
  }
  return { names, attention }
}

