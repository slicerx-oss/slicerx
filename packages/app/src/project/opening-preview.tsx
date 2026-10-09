// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The picture of the plate a project carries (Bambu Studio and OrcaSlicer save Metadata/plate_1.png, PrusaSlicer
// Metadata/thumbnail.png), shown over the 3D view the moment a project starts to open, until its objects are on the
// plate. Only that one small entry is inflated, so it shows long before a big model is read.
import { useSyncExternalStore } from 'react'

export interface OpeningPreview {
  url: string
  name: string
}

/** The pictures a project may carry, the one to show first. A plate's pick map (pick_1.png) is no picture. */
const PICTURES = ['Metadata/plate_1.png', 'Metadata/top_1.png', 'Metadata/plate_1_small.png', 'Metadata/thumbnail.png', 'Metadata/Thumbnails/thumbnail.png']
const MAX_BYTES = 4 * 1024 * 1024
const LIMITS = { entries: 4000, entry: MAX_BYTES, total: 768 * 1024 * 1024, what: 'a 3MF archive' }

let shown: OpeningPreview | null = null
let seq = 0
const listeners = new Set<() => void>()

function publish(next: OpeningPreview | null): void {
  if (shown) URL.revokeObjectURL(shown.url)
  shown = next
  for (const l of listeners) l()
}

/**
 * Shows the project's plate picture while it opens, when it has one. Returns a function that takes it down again; it is
 * safe to call more than once, and once a newer open showed its own, it leaves that one alone.
 */
export function showOpeningPreview(bytes: Uint8Array, name: string): () => void {
  const mine = ++seq
  let done = false
  void (async () => {
    try {
      // Loaded here, not with the view this module's hook serves.
      const { unzipEntries } = await import('../export/unzip')
      const files = await unzipEntries(bytes, LIMITS, (n) => PICTURES.includes(n))
      const png = PICTURES.map((p) => files.get(p)).find((b) => b && b.length > 0 && b.length <= MAX_BYTES)
      if (!png || done || mine !== seq || typeof URL.createObjectURL !== 'function') return
      publish({ url: URL.createObjectURL(new Blob([png.slice()], { type: 'image/png' })), name })
    } catch {
      // No picture, or an archive the open itself will report on.
    }
  })()
  return () => {
    done = true
    if (mine === seq && shown) publish(null)
  }
}

/** The picture shown now, or null. */
export function openingPreview(): OpeningPreview | null {
  return shown
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useOpeningPreview(): OpeningPreview | null {
  return useSyncExternalStore(subscribe, () => shown, () => null)
}

/** The picture over the 3D view, with the file's name. */
export function OpeningPicture() {
  const p = useOpeningPreview()
  if (!p) return null
  return (
    <figure className="opening-picture" aria-label={`Opening ${p.name}`}>
      <img src={p.url} alt="" />
      <figcaption>Opening {p.name}</figcaption>
    </figure>
  )
}
