// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Fragment, memo } from 'react'
import type { ApprovalRequest } from '@slicerx/contracts'
import { ApprovalCard } from './approval-card'
import { ChoiceCard } from './choice-card'
import { LookupRecord } from './lookup-record'
import { SheetRecord } from './sheet-record'
import { Citations } from './citations'
import { Diff } from './diff'
import { ErrorLine, ModelLine, PermLine, PlanList, PluginsLoading } from './notes'
import { createdPart, turnPart } from './part'
import { FollowUpChips, PartCard, type PartHandlers } from './part-card'
import type { Block, Transcript } from './reduce'
import { Say } from './say'
import { Summary } from './summary'
import { Think } from './think'
import { ToolGroup, type StepWords } from './tool-group'
import { Bubble, PilotTurn } from './turn'

export interface ApprovalHandlers {
  onApprove: (request: ApprovalRequest, opts: { bedClear: boolean }) => Promise<void>
  onCancel: (request: ApprovalRequest) => Promise<void>
  onEditPlan?: ((request: ApprovalRequest) => void) | undefined
  /** Answers a choice card; without it the cards cannot be answered. */
  onChoose?: ((askId: string, choiceId: string) => Promise<void>) | undefined
  /** Confirms a dimension sheet with its values; without it a sheet waits for another surface to answer it. */
  onConfirmSheet?: ((sheetId: string, values: Record<string, number>) => Promise<void>) | undefined
  /** Brings a sheet up where it is edited (the mimir tab's panel); with it the record links there instead of confirming. */
  onOpenSheet?: ((sheetId: string) => void) | undefined
}

// Unchanged blocks keep their identity in the reducer, so a streaming delta repaints only its own block.
const BlockView = memo(function BlockView({ block, showThinking, approvals, words, parts }: { block: Block; showThinking: boolean; approvals: ApprovalHandlers; words?: StepWords | undefined; parts?: PartHandlers | undefined }) {
  switch (block.kind) {
    case 'plugins':
      return <PluginsLoading plugins={block.plugins} />
    case 'think':
      return <Think text={block.text} ms={block.ms} showThinking={showThinking} />
    case 'say':
      return <Say text={block.text} streaming={block.streaming} />
    case 'plan':
      return <PlanList steps={block.steps} />
    case 'tools': {
      if (!parts) return <ToolGroup rows={block.rows} words={words} />
      // a call that made a part shows as the part's card; the other calls stay rows
      const made = block.rows.map((r) => ({ r, part: createdPart(r) }))
      if (!made.some((m) => m.part)) return <ToolGroup rows={block.rows} words={words} />
      const rest = made.filter((m) => !m.part).map((m) => m.r)
      return (
        <>
          {rest.length ? <ToolGroup rows={rest} words={words} /> : null}
          {made.map((m) => (m.part ? <PartCard key={m.r.callId} part={m.part} handlers={parts} /> : null))}
        </>
      )
    }
    case 'diff':
      return <Diff diff={block.diff} />
    case 'perm':
      return <PermLine mode={block.mode} message={block.message} />
    case 'model':
      return <ModelLine label={block.label} reason={block.reason} />
    case 'approval':
      return (
        <ApprovalCard
          request={block.request}
          resolution={block.resolution}
          actionable={!block.replay}
          onApprove={approvals.onApprove}
          onCancel={approvals.onCancel}
          onEditPlan={approvals.onEditPlan}
        />
      )
    case 'lookup':
      return <LookupRecord lookup={block.lookup} />
    case 'sheet':
      return <SheetRecord sheet={block.sheet} answer={block.answer} bound={block.bound !== undefined} actionable={!block.replay} onConfirm={approvals.onConfirmSheet} onOpen={approvals.onOpenSheet} />
    case 'choice':
      return <ChoiceCard askId={block.askId} title={block.title} question={block.question} choices={block.choices} picked={block.picked} actionable={!block.replay} onChoose={approvals.onChoose} />
    case 'summary':
      return <Summary title={block.title} rows={block.rows} stopped={block.stopped} ms={block.ms} />
    case 'citations':
      return <Citations items={block.items} />
    case 'error':
      return <ErrorLine message={block.message} code={block.code} />
  }
})

/**
 * Every turn in order. `words` puts tool calls in the person's words ("Sketching the outline"); the tool's own name moves
 * to the row's tooltip.
 */
export function TranscriptView({ transcript, showThinking, approvals, words, parts }: { transcript: Transcript; showThinking: boolean; approvals: ApprovalHandlers; words?: StepWords; parts?: PartHandlers }) {
  const last = transcript.turns.at(-1)
  return (
    <>
      {transcript.turns.map((t) => {
        // each reply that made a part keeps its next steps, bound to that part, once the reply has finished
        const part = parts ? turnPart(t) : null
        const done = t !== last || transcript.status !== 'running'
        return (
          <Fragment key={t.id}>
            {t.user !== null ? <Bubble text={t.user} where={t.where} attachments={t.attachments} /> : null}
            <PilotTurn>
              {/* the part card already shows what happened, so the turn's permission line is dropped */}
              {(part ? t.blocks.filter((b) => b.kind !== 'perm') : t.blocks).map((b) => (
                <BlockView key={b.id} block={b} showThinking={showThinking} approvals={approvals} words={words} parts={parts} />
              ))}
              {part && parts && done ? <FollowUpChips part={part} handlers={parts} /> : null}
            </PilotTurn>
          </Fragment>
        )
      })}
    </>
  )
}
