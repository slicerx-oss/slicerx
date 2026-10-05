// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The checks before a print, as the Print sheet and the approval card show them: one short line per
// issue, its detail behind a Details tooltip, nothing at all when no check fired.
import { Icon, tipAttrs } from '@slicerx/ui'
import type { SheetNote } from '../plate/lint'
import './check-lines.css'

export interface CheckLine extends SheetNote {
  /** bad blocks the print; warn asks for a look and lets it go ahead. */
  tone: 'bad' | 'warn'
}

/** A check worded as one long message: its first sentence is the line, the rest goes to the tooltip. */
export function noteOf(message: string): SheetNote {
  const m = /^(.+?[.!?])\s+(?=[A-Z])([\s\S]+)$/.exec(message.trim())
  return m ? { text: m[1]!, tip: m[2]! } : { text: message.trim() }
}

/** The lines in order: what blocks first, then what to look at. */
export function checkLines(errors: readonly (string | SheetNote)[], warnings: readonly (string | SheetNote)[]): CheckLine[] {
  const line = (tone: CheckLine['tone']) => (n: string | SheetNote): CheckLine => ({ tone, ...(typeof n === 'string' ? noteOf(n) : n) })
  return [...errors.map(line('bad')), ...warnings.map(line('warn'))]
}

export function CheckLines({ lines, label = 'Checks' }: { lines: readonly CheckLine[]; label?: string }) {
  if (!lines.length) return null
  return (
    <ul className="cl-list" aria-label={label}>
      {lines.map((n) => (
        <li key={`${n.tone}:${n.text}`} className="cl-line" data-tone={n.tone} role={n.tone === 'bad' ? 'alert' : undefined}>
          <Icon name={n.tone === 'bad' ? 'alert' : 'warning'} size={18} />
          <span className="cl-text">{n.text.replace(/[.!?]$/, '')}</span>
          {n.tip ? (
            <button type="button" className="cl-more" data-tip-click="" {...tipAttrs({ title: n.text, body: n.tip })}>
              Details
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
