// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The docked conversation, kept for the tab's session once each run ends, so a reload picks it back up where it was.
// A new window or tab starts fresh, and so does New conversation.
import type { Transcript } from '@slicerx/pilot/ui'

const KEY = 'sx-mimir-dock-chat'
/** A conversation bigger than this is not kept. Files on the turns are kept by name only. */
const MAX_CHARS = 400_000

export interface DockChat {
  sessionId: string
  transcript: Transcript
}

function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

export function savedDockChat(): DockChat | null {
  try {
    const raw = store()?.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<DockChat>
    return typeof v.sessionId === 'string' && v.transcript && Array.isArray(v.transcript.turns) && v.transcript.turns.length > 0 ? { sessionId: v.sessionId, transcript: v.transcript } : null
  } catch {
    return null
  }
}

/** Keeps the conversation once a run has ended; one still running is kept at its end. */
export function saveDockChat(sessionId: string, transcript: Transcript): void {
  if (transcript.status === 'running' || transcript.turns.length === 0) return
  try {
    // a file's data stays out of storage; its chip comes back with a plain icon
    const raw = JSON.stringify({ sessionId, transcript }, (k, v: unknown) => (k === 'url' && typeof v === 'string' && v.startsWith('data:') ? '' : v))
    if (raw.length > MAX_CHARS) store()?.removeItem(KEY)
    else store()?.setItem(KEY, raw)
  } catch {
    // storage full or refused: a reload starts fresh, as before
  }
}

export function clearDockChat(): void {
  try {
    store()?.removeItem(KEY)
  } catch {
    // nothing kept
  }
}
