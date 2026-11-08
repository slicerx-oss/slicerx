// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the conversation has a card waiting for the person: a print or a change to approve, or a question or plan to
// answer. On a phone the view folds to a strip while one waits (mimir-phone.css), so the card fits in the chat with its
// buttons above the composer. A size sheet does not count: its drawing is in the view. Only a run that is still going
// waits; once it stops, a card left unanswered can no longer be answered. `openChoice` is the question card a written
// reply answers: the newest one still waiting, never an approval. `openSheetCard` is the size sheet waiting there, which
// a written reply sets aside.
import { dimUnit } from '@slicerx/contracts/size-kind'
import type { Transcript } from '@slicerx/pilot/ui'

export function cardWaits(t: Transcript): boolean {
  return t.status === 'running' && t.turns.some((turn) => turn.blocks.some((b) => (b.kind === 'approval' && b.resolution === null && !b.replay) || (b.kind === 'choice' && b.picked === null && !b.replay)))
}

/** The newest question card (a choice, a plan or a printer pick) waiting in a running reply, or null. */
export function openChoice(t: Transcript): { askId: string; title: string; question: string; choices: { id: string; label: string }[] } | null {
  if (t.status !== 'running') return null
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const blocks = t.turns[i]!.blocks
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k]!
      if (b.kind === 'choice' && b.picked === null && !b.replay) return { askId: b.askId, title: b.title, question: b.question, choices: b.choices }
    }
  }
  return null
}

/** A row's unit by name, for a client: the sheet's own units, and `count` for a count, which has none. */
const UNIT_NAME = { '': 'count', '°': 'deg', '%': '%', mm: 'mm' } as const

/**
 * The newest size sheet waiting in a running reply, with its rows, or null. Each row's unit is the one the sheet shows it
 * in (dimUnit): `count` for a count given in mm, `deg` for an angle given in mm, else its own.
 */
export function openSheetCard(t: Transcript): { sheetId: string; title: string; sizes: { key: string; label: string; value: number; unit: string }[] } | null {
  if (t.status !== 'running') return null
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const blocks = t.turns[i]!.blocks
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k]!
      if (b.kind === 'sheet' && b.answer === null && !b.replay) return { sheetId: b.sheet.id, title: b.sheet.title, sizes: b.sheet.dims.map((d) => ({ key: d.key, label: d.label, value: d.value, unit: UNIT_NAME[dimUnit(d)] })) }
    }
  }
  return null
}
