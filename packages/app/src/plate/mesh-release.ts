// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Letting go of meshes the engine no longer needs. Every object, volume and painted object is a mesh loaded into the
// slicer (each browser worker's engine, or the desktop shell), and nothing released them, so a session kept every
// mesh it ever loaded: each open, each edit that loads the part again, each paint change. A mesh is released once
// nothing can bring its object back: no plate, no undo or redo step, no open history step and no clipboard holds it.
import type { SlicerHost } from '@slicerx/contracts'
import { appStore, type AppState, type PlateEntry } from '../state/store'
import { clipboard, subscribeClipboard } from './clipboard'
import { history, type History, type Snapshot } from './history'
import { releasePainted } from './painted'

/** How long after the last change the check runs, so a burst of edits is one pass. */
export const RELEASE_DELAY_MS = 1000

function addEntries(entries: readonly PlateEntry[] | undefined, into: Set<string>): void {
  for (const e of entries ?? []) {
    into.add(e.handle.id)
    for (const v of e.volumes ?? []) into.add(v.handle.id)
  }
}

/** Every mesh id the state, the undo and redo steps and the clipboard can still put on a plate. */
export function heldMeshes(s: AppState, steps: readonly Snapshot[]): Set<string> {
  const out = new Set<string>()
  for (const st of [s, ...steps]) {
    addEntries(st.plate, out)
    for (const p of st.plates ?? []) addEntries(p.objects, out)
  }
  if (s.historyEdit) addEntries([s.historyEdit.original], out)
  const clip = clipboard()
  if (clip?.kind === 'objects') addEntries(clip.entries, out)
  if (clip?.kind === 'volumes') for (const v of clip.volumes) out.add(v.handle.id)
  return out
}

/**
 * Watches the plates and releases each mesh once nothing holds it. Only meshes that were on a plate count, so one
 * that is still being loaded for an open is never let go early, and nothing is released while a slice runs (its
 * request names the meshes it was made from). Returns the stop function.
 */
export function startMeshRelease(slicer: Pick<SlicerHost, 'release'>, opts: { delayMs?: number; history?: Pick<History, 'snapshots' | 'subscribe'> } = {}): () => void {
  const delay = opts.delayMs ?? RELEASE_DELAY_MS
  const steps = opts.history ?? history()
  const seen = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const pass = (): void => {
    timer = null
    const s = appStore.getState()
    if (s.slice.status === 'running' || s.plateLoading) return schedule()
    const held = heldMeshes(s, steps.snapshots())
    for (const id of seen) {
      if (held.has(id)) continue
      seen.delete(id)
      slicer.release(id)
    }
    for (const id of held) seen.add(id)
    // Painted copies are made again from their object when needed, so only the ones for the plates as they are stay.
    releasePainted(slicer, s)
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(pass, delay)
  }
  const off = appStore.subscribe((s, prev) => {
    if (s.plate !== prev.plate || s.plates !== prev.plates || s.historyEdit !== prev.historyEdit || s.slice !== prev.slice || s.plateLoading !== prev.plateLoading) schedule()
  })
  const offClip = subscribeClipboard(schedule)
  const offHistory = steps.subscribe(schedule)
  schedule()
  return () => {
    if (timer) clearTimeout(timer)
    off()
    offClip()
    offHistory()
  }
}
