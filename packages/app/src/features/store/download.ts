// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fetching a library model: one call for the signed link, one for the bytes.
import type { FileFormat, Listing, StoreClient } from '@slicerx/contracts'

export type ModelFetch =
  | { ok: true; name: string; bytes: ArrayBuffer }
  | { ok: false; reason: 'sign-in' | 'error'; message: string }

const FORMATS: readonly string[] = ['sx3mf', '3mf', 'stl']

/** True for the three library formats. */
export function isLibraryFormat(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return FORMATS.includes(ext)
}

export function formatLabel(format: FileFormat | undefined): string {
  return format ? format.toUpperCase() : 'Model'
}

/** Downloads count on the server the moment the link is made, so ask only when the person acts. */
export async function fetchModel(store: StoreClient, listing: Listing, get: typeof fetch = fetch): Promise<ModelFetch> {
  const link = await store.download(listing.id)
  if (!link.ok) {
    if (link.code === 'not_signed_in') return { ok: false, reason: 'sign-in', message: 'Sign in to download models.' }
    return { ok: false, reason: 'error', message: link.message }
  }
  if (!/^https?:|^blob:|^data:/.test(link.value.url)) {
    return { ok: false, reason: 'error', message: `${listing.title} has no file in this catalog.` }
  }
  try {
    const res = await get(link.value.url)
    if (!res.ok) return { ok: false, reason: 'error', message: `The download failed (${res.status}).` }
    if (!isLibraryFormat(link.value.fileName)) return { ok: false, reason: 'error', message: `${link.value.fileName} is not a 3MF, sx3mf or STL file.` }
    return { ok: true, name: link.value.fileName, bytes: await res.arrayBuffer() }
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : 'The download failed.' }
  }
}
