// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Fragment, memo } from 'react'
import type { ApprovalRequest, PluginLoad } from '@slicerx/contracts'
import { ApprovalCard } from './approval-card'
import { ChoiceCard } from './choice-card'
import { LookupRecord } from './lookup-record'
import { SheetRecord } from './sheet-record'
import { Citations } from './citations'
import { Diff } from './diff'
import { ErrorLine, ModelLine, PermLine, PlanList, UsedLine } from './notes'
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
const BlockView = memo(function BlockView({ block, showThinking, approvals, words }: { block: Block; showThinking: boolean; approvals: ApprovalHandlers; words?: StepWords | undefined }) {
  switch (block.kind) {
    case 'think':
      return <Think text={block.text} ms={block.ms} showThinking={showThinking} />
    case 'say':
      return <Say text={block.text} streaming={block.streaming} />
    case 'plan':
      return <PlanList steps={block.steps} />
    case 'tools':
      return <ToolGroup rows={block.rows} words={words} />
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

/** The integrations a reply used, by name; the built-in printer tools (`printer.*`) are no integration and are left out. */
function usedNames(used: string[] | undefined, plugins: PluginLoad[] | null | undefined): string[] {
  return (used ?? []).flatMap((id) => plugins?.find((p) => p.id === id)?.name ?? [])
}

/**
 * Every turn in order. `words` puts tool calls in the person's words ("Sketching the outline"); the tool's own name moves
 * to the row's tooltip.
 */
export function TranscriptView({ transcript, showThinking, approvals, words }: { transcript: Transcript; showThinking: boolean; approvals: ApprovalHandlers; words?: StepWords }) {
  return (
    <>
      {transcript.turns.map((t) => (
        <Fragment key={t.id}>
          {t.user !== null ? <Bubble text={t.user} where={t.where} attachments={t.attachments} /> : null}
          <PilotTurn>
            {t.blocks.map((b) => (
              <BlockView key={b.id} block={b} showThinking={showThinking} approvals={approvals} words={words} />
            ))}
            <UsedLine names={usedNames(t.used, transcript.plugins)} />
          </PilotTurn>
        </Fragment>
      ))}
    </>
  )
}
