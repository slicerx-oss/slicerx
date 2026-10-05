// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the "Import an SVG" dialog is open.
import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function write(v: boolean): void {
  open = v
  for (const l of listeners) l()
}

export const openSvgImport = (): void => write(true)
export const closeSvgImport = (): void => write(false)

export function useSvgImportOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => open,
    () => false,
  )
}
