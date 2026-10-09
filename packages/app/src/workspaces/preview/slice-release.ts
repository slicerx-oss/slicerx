// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Letting go of finished slices. Each slice leaves its G-code and preview in the slicer (the desktop shell, or the
// browser pool), and nothing released them, so a session kept every slice it ever made. A slice is released once
// neither the view nor a plate out of view (plate-slices.ts, at most KEEP of them) holds it: replaced by a newer
// slice, dropped with its plate, or gone with the project.
import type { SlicerHost } from '@slicerx/contracts'
import { appStore, type AppState } from '../../state/store'
import { keptSliceIds } from './plate-slices'

/**
 * How long a slice no one holds is kept before it goes, so an export or a G-code read that started just before a
 * newer slice landed can finish.
 */
export const SLICE_RELEASE_DELAY_MS = 5000

/** The slices the view holds: the one shown, and the last one kept on screen while a new one runs. */
export function heldSlices(s: Pick<AppState, 'slice'>, kept: readonly string[] = keptSliceIds()): Set<string> {
  const out = new Set(kept)
  if (s.slice.status === 'done') out.add(s.slice.result.id)
  if (s.slice.status === 'running' && s.slice.last) out.add(s.slice.last.id)
  return out
}

/** Watches the slices and releases each one nothing holds any more. Returns the stop function. */
export function startSliceRelease(slicer: Pick<SlicerHost, 'release'>, opts: { delayMs?: number; kept?: () => readonly string[] } = {}): () => void {
  const delay = opts.delayMs ?? SLICE_RELEASE_DELAY_MS
  const kept = opts.kept ?? keptSliceIds
  const seen = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const pass = (): void => {
    timer = null
    const held = heldSlices(appStore.getState(), kept())
    for (const id of seen) {
      if (held.has(id)) continue
      seen.delete(id)
      slicer.release(id)
    }
    for (const id of held) seen.add(id)
  }
  const off = appStore.subscribe((s, prev) => {
    if (s.slice === prev.slice && s.plates === prev.plates && s.activePlate === prev.activePlate) return
    // New slices count at once; letting go waits a little.
    for (const id of heldSlices(s, kept())) seen.add(id)
    if (timer) clearTimeout(timer)
    timer = setTimeout(pass, delay)
  })
  return () => {
    if (timer) clearTimeout(timer)
    off()
  }
}
