// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A paint preview that is refused never gets an id, so an apply of the id a client meant to get finds nothing. When
// the last paint preview was refused, the apply's refusal names that preview and why it was refused, with what to do
// next. The server's paint.apply and the app link's paint.apply both say it from here.

/** A refused paint preview: its step's name and the refusal as it was thrown. */
export interface RefusedPreview {
  step: string
  message: string
}

const STOPPED = /^Exact replay stopped:\s*/
const TAILS = ['The mesh path was not used.', 'The design is unchanged.']

/** A refusal's own reason, without the replay's wrapping words, and with no closing period. */
export function refusalReason(message: string): string {
  let s = message.trim().replace(STOPPED, '')
  for (let cut = true; cut; ) {
    cut = false
    for (const t of TAILS)
      if (s.endsWith(t)) {
        s = s.slice(0, -t.length).trimEnd()
        cut = true
      }
  }
  return s.replace(/\.+$/, '')
}

/** What to do after a refused preview: another part or target for exact replay, another target for one that paints nothing. */
export function refusalNext(message: string): string {
  if (/Exact replay/.test(message)) return 'Preview again on a part that supports paint, or with a different target, then apply.'
  if (/paints nothing new/.test(message)) return 'Preview again with another target, part or state, then apply.'
  return 'Preview again, then apply.'
}

/** The sentence for an apply given `id`, which no preview has, after the refused preview `r`. */
export function neverMadeText(id: string, r: RefusedPreview): string {
  return `preview: ${id} was never made. The last paint preview, ${r.step}, was refused: ${refusalReason(r.message)}. ${refusalNext(r.message)}`
}

/**
 * The last refused paint preview for each key (the server's paint tools keep one key, the app link one per client):
 * set when a preview is refused, cleared when one goes through or a preview is applied.
 */
export class RefusedPreviews {
  private readonly last = new Map<string, RefusedPreview>()

  refused(key: string, step: string, error: unknown): void {
    this.last.delete(key)
    this.last.set(key, { step, message: error instanceof Error ? error.message : String(error) })
    if (this.last.size > 32) this.last.delete(this.last.keys().next().value!)
  }

  clear(key: string): void {
    this.last.delete(key)
  }

  /** The refusal for an apply of `id`, which no preview has: `otherwise` when no refused preview is on record. */
  neverMade(key: string, id: string, otherwise: string): string {
    const r = this.last.get(key)
    return r ? neverMadeText(id, r) : otherwise
  }
}
