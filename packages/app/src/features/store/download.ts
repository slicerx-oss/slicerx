// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fetching a library model: one call for the signed link, one for the bytes.
import type { FileFormat, Listing, StoreClient } from '@slicerx/contracts'

export type ModelFetch =
  | { ok: true; name: string; bytes: ArrayBuffer; version: string }
  | { ok: false; reason: 'sign-in' | 'error' | 'canceled'; message: string }

export interface FetchOptions {
  /** Stops the download; the result is then reason 'canceled'. */
  signal?: AbortSignal
  /** Bytes so far and the total, when the server sends a length. */
  onProgress?: (got: number, total: number | null) => void
}

/** A size for the progress line: KB under a megabyte, MB above. */
export function formatBytes(n: number): string {
  if (n < 1e6) return `${Math.max(n > 0 ? 1 : 0, Math.round(n / 1e3))} KB`
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`
}

/** Reads a response body, reporting each chunk. */
async function readBody(res: Response, onProgress?: (got: number, total: number | null) => void): Promise<ArrayBuffer> {
  const total = Number(res.headers.get('content-length')) || null
  if (!onProgress || !res.body) return res.arrayBuffer()
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let got = 0
  onProgress(0, total)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    got += value.byteLength
    onProgress(got, total)
  }
  const out = new Uint8Array(got)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out.buffer
}

const FORMATS: readonly string[] = ['sx3mf', '3mf', 'stl']

/** True for the three library formats. */
export function isLibraryFormat(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return FORMATS.includes(ext)
}

export function formatLabel(format: FileFormat | undefined): string {
  return format ? format.toUpperCase() : 'Model'
}

/** Vault files leave only as .sx3mf, except to their own creator. The server enforces it; this refuses anything else it might hand out. */
export function allowedVaultFile(fileName: string, own: boolean): boolean {
  return own || /\.sx3mf$/i.test(fileName)
}

/** Downloads count on the server the moment the link is made, so ask only when the person acts. `own`: the signed-in member made the listing. Never throws: every failure comes back as a message. */
export async function fetchModel(store: StoreClient, listing: Listing, get: typeof fetch = fetch, own = false, opts: FetchOptions = {}): Promise<ModelFetch> {
  const { signal, onProgress } = opts
  const canceled: ModelFetch = { ok: false, reason: 'canceled', message: 'Download canceled.' }
  try {
    const link = await store.download(listing.id)
    if (!link.ok) {
      if (link.code === 'not_signed_in') return { ok: false, reason: 'sign-in', message: 'Sign in to download models.' }
      return { ok: false, reason: 'error', message: link.message || 'The download could not be started.' }
    }
    if (!/^https?:|^blob:|^data:/.test(link.value.url)) {
      return { ok: false, reason: 'error', message: `${listing.title} has no file in this catalog.` }
    }
    if (!allowedVaultFile(link.value.fileName, own)) {
      return { ok: false, reason: 'error', message: `${listing.title} is not available as an .sx3mf yet.` }
    }
    if (!isLibraryFormat(link.value.fileName)) return { ok: false, reason: 'error', message: `${link.value.fileName} is not a 3MF, sx3mf or STL file.` }
    // A signed-out download carries its grant in headers.
    if (signal?.aborted) return canceled
    const init: RequestInit = { ...(link.value.headers ? { headers: link.value.headers } : {}), ...(signal ? { signal } : {}) }
    const res = await get(link.value.url, Object.keys(init).length ? init : undefined)
    if (!res.ok) return { ok: false, reason: 'error', message: res.status === 404 || res.status === 400 ? `The file for ${listing.title} is missing (${res.status}).` : `The download failed (${res.status}).` }
    const bytes = await readBody(res, onProgress)
    return signal?.aborted ? canceled : { ok: true, name: link.value.fileName, bytes, version: link.value.version }
  } catch (e) {
    if (signal?.aborted) return canceled
    return { ok: false, reason: 'error', message: e instanceof Error && e.message ? `The download failed: ${e.message}` : 'The download failed.' }
  }
}
