// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the Library shows over its rows: a creator's sheet, a design's sheet,
// or the creator page editor. Kept outside React so the account settings and
// commands can open them too.
import type { StoreClient } from '@slicerx/contracts'
import { useSyncExternalStore } from 'react'
import { setWorkspace, toast } from '@slicerx/app'

export interface LibrarySheets {
  /** Handle of the creator whose sheet is open. */
  creator: string | null
  /** Id of the listing whose sheet is open. */
  listing: string | null
  /** The creator page editor. 'upload' when it opened from Upload for someone without a page. */
  editor: null | 'edit' | 'upload'
  /** The upload flow: the form for a new design, or the list of your uploads. */
  upload: null | 'form' | 'list'
  /** The review queue, for the owner and moderators. */
  review: boolean
}

const EMPTY: LibrarySheets = { creator: null, listing: null, editor: null, upload: null, review: false }
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
export const openReview = (): void => set({ ...current, review: true, upload: null, editor: null, creator: null, listing: null })
export const closeReview = (): void => set({ ...current, review: false })
export const closeSheet = (): void => set({ ...current, creator: null, listing: null })
export const resetSheets = (): void => set(EMPTY)
/** The sheets now, outside React. */
export const librarySheets = (): LibrarySheets => current

/**
 * Opens a design from a link to it (`slicerx://vault/<slug>`, from its page on the website): the Vault tab with the
 * design's sheet over it. A design that is gone or not public says so.
 */
export async function openVaultLink(store: Pick<StoreClient, 'getListing'>, slug: string): Promise<boolean> {
  const found = await store.getListing(slug).catch(() => null)
  if (!found) {
    toast("That design isn't on the Vault, or isn't public yet", 'error')
    return false
  }
  setWorkspace('feed')
  openListing(found.listing.id)
  return true
}

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
