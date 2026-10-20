// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print run's cards in the mimir tab, as one registry the chat's handlers spread in: the approval cards that replace
// the ordinary card for the runtime's own tools (by tool name), the card for each run step, and the card for a question
// the run asks. A card whose task has not landed yet is left out, so the chat keeps its ordinary card there.
import type { PrintRun } from '@slicerx/contracts'
import type { ApprovalCardProps, ChoiceCardProps } from '@slicerx/pilot/ui'
import type { ComponentType, ReactNode } from 'react'
import { ProgressCard } from './progress-card'
import { SendCard } from './send-card'
import { SliceCard } from './slice-card'
import { isTargetAsk, TargetCard } from './target-card'

export interface RunCardProps {
  run: PrintRun | null
  actionable: boolean
}

/**
 * Cards in place of the approval card, by tool name. The chat uses them only for the runtime's own tools, never for a
 * plugin's tool of the same name: the send card for printer.queue.
 */
export const RUN_APPROVAL_CARDS: Readonly<Record<string, ComponentType<ApprovalCardProps>>> = { 'printer.queue': SendCard }

/** The card for a run step: the slice the run made, or the print it started. */
export function runCard(p: { stage: 'slice' | 'progress'; run: PrintRun | null; actionable: boolean }): ReactNode {
  return p.stage === 'slice' ? <SliceCard run={p.run} actionable={p.actionable} /> : <ProgressCard run={p.run} actionable={p.actionable} />
}

/** A card of the run's own for a question it asks; null keeps the choice card. The printer and spool pick has its own. */
export function runChoiceCard(props: ChoiceCardProps): ReactNode {
  return isTargetAsk(props.choices) ? <TargetCard key={props.askId} {...props} /> : null
}
