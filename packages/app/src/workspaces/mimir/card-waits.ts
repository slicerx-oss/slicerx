// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the conversation has a card waiting for the person: a print or a change to approve, or a question or plan to
// answer. On a phone the view folds to a strip while one waits (mimir-phone.css), so the card fits in the chat with its
// buttons above the composer. A size sheet does not count: its drawing is in the view. Only a run that is still going
// waits; once it stops, a card left unanswered can no longer be answered.
import type { Transcript } from '@slicerx/pilot/ui'

export function cardWaits(t: Transcript): boolean {
  return t.status === 'running' && t.turns.some((turn) => turn.blocks.some((b) => (b.kind === 'approval' && b.resolution === null && !b.replay) || (b.kind === 'choice' && b.picked === null && !b.replay)))
}
