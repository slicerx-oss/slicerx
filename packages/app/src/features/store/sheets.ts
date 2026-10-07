// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the Library shows over its rows: a creator's sheet, a design's sheet,
// or the creator page editor. Kept outside React so the account settings and
// commands can open them too.
import { useSyncExternalStore } from 'react'

export interface LibrarySheets {
  /** Handle of the creator whose sheet is open. */
  creator: string | null
  /** Id of the listing whose sheet is open. */
  listing: string | null
  /** The creator page editor. 'upload' when it opened from Upload for someone without a page. */
  editor: null | 'edit' | 'upload'
  /** The upload flow: the form for a new design, or the list of your uploads. */
  upload: null | 'form' | 'list'
}

const EMPTY: LibrarySheets = { creator: null, listing: null, editor: null, upload: null }
let current: LibrarySheets = EMPTY
const listeners = new Set<() => void>()

function set(next: LibrarySheets): void {
  current = next
  for (const l of listeners) l()
}

export const openCreator = (handle: string): void => set({ ...current, creator: handle, listing: null })
export const openListing = (id: string): void => set({ ...current, listing: id, creator: null })
export const openEditor = (why: 'edit' | 'upload' = 'edit'): void => set({ ...current, editor: why })
export const closeEditor = (): void => set({ ...current, editor: null })
export const openUpload = (view: 'form' | 'list' = 'form'): void => set({ ...current, upload: view, editor: null, creator: null, listing: null })
export const closeUpload = (): void => set({ ...current, upload: null })
export const closeSheet = (): void => set({ ...current, creator: null, listing: null })
export const resetSheets = (): void => set(EMPTY)

export function useLibrarySheets(): LibrarySheets {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
    () => current,
  )
}
