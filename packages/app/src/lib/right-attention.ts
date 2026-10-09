// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When Slice's shut right pane wants a look: a finished slice with warnings, an object problem (off the bed, a missing
// filament and so on), a fit check note, or a print that finished or failed. Each gives a key; the pane's edge tab
// glows for a key the person has not seen with the pane open. A clean slice gives none, so the tab stays calm.
import { useEffect } from 'react'
import { allTouches, objectFit, useFits } from '../plate/fit-state'
import { objectWarnings } from '../plate/object-list'
import { get, set, shownSlice, useApp, type AppState } from '../state/store'

/** What wants a look in the right pane now, as one key, or null when nothing does. */
export function attentionKey(s: Pick<AppState, 'slice' | 'plate' | 'bed' | 'printerSlots'>, fitIds: readonly string[], printResult: string | null): string | null {
  const parts: string[] = []
  const done = shownSlice(s.slice)
  if (done && !done.stale && done.result.warnings.length > 0) parts.push(`slice:${done.result.id}`)
  for (const p of s.plate) {
    const kinds = objectWarnings(p, s).map((w) => w.kind)
    if (kinds.length) parts.push(`object:${p.id}:${kinds.join(',')}`)
  }
  if (fitIds.length) parts.push(`fit:${[...fitIds].sort().join(',')}`)
  if (printResult) parts.push(`print:${printResult}`)
  return parts.length ? parts.join('|') : null
}

/**
 * Whether the right pane's tab glows: something wants a look and the person has not seen it with the pane open.
 * Opening the pane marks what it shows as seen. `printResult` names a print that finished or failed, or null.
 */
export function useRightAttention(open: boolean, printResult: string | null): boolean {
  const fitsVersion = useFits()
  const key = useApp((s) => {
    void fitsVersion
    const fitIds = [...new Set([...s.plate.filter((p) => objectFit(p.id)).map((p) => p.id), ...allTouches().flatMap((t) => t.ids)])]
    return attentionKey(s, fitIds, printResult)
  })
  const seen = useApp((s) => s.rightSeen)
  useEffect(() => {
    if (open && get().rightSeen !== key) set({ rightSeen: key })
  }, [open, key])
  return !open && key !== null && key !== seen
}
