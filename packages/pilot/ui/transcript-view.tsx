// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Fragment, memo, type ComponentType, type ReactNode } from 'react'
import type { ApprovalRequest, PluginLoad, PrintRun } from '@slicerx/contracts'
import { ApprovalCard, type ApprovalCardProps } from './approval-card'
import { ChoiceCard, type ChoiceCardProps } from './choice-card'
import { LookupRecord } from './lookup-record'
import { SheetRecord } from './sheet-record'
import { Citations } from './citations'
import { Diff } from './diff'
import { ErrorLine, ModelLine, PermLine, PlanList, UsedLine } from './notes'
import { createdPart, turnPart } from './part'
import { FollowUpChips, PartCard, type PartHandlers } from './part-card'
import { runShown, type Block, type Transcript } from './reduce'
import { Say } from './say'
import { Summary } from './summary'
import { Think } from './think'
import { ToolGroup, type StepWords } from './tool-group'
import { Bubble, PilotTurn } from './turn'

export interface ApprovalHandlers {
  onApprove: (request: ApprovalRequest, opts: { bedClear: boolean }) => Promise<void>
  onCancel: (request: ApprovalRequest) => Promise<void>
  onEditPlan?: ((request: ApprovalRequest) => void) | undefined
  /**
   * A tool's own card in place of the approval card, by tool name, such as the host's chip for memory.remember. Used only
   * for the runtime's own tools: a plugin's tool of the same name gets the ordinary approval card.
   */
  cards?: Readonly<Record<string, ComponentType<ApprovalCardProps>>> | undefined
  /** Answers a choice card; without it the cards cannot be answered. */
  onChoose?: ((askId: string, choiceId: string) => Promise<void>) | undefined
  /** A card of the host's own for a question it recognizes (a plan to approve); null keeps the choice card. */
  choiceCard?: ((props: ChoiceCardProps) => ReactNode) | undefined
  /** Confirms a dimension sheet with its values; without it a sheet waits for another surface to answer it. */
  onConfirmSheet?: ((sheetId: string, values: Record<string, number>) => Promise<void>) | undefined
  /** Answers a waiting sheet as not confirmed, so nothing builds. */
  onCancelSheet?: ((sheetId: string) => Promise<void>) | undefined
  /** Brings a built sheet's panel back, where a tied row edits its step. */
  onOpenSheet?: ((sheetId: string) => void) | undefined
  /** A size typed on a waiting sheet's record; with it the record's rows are fields. */
  onEditSheet?: ((sheetId: string, key: string, value: number) => void) | undefined
  /** The sizes typed so far on the waiting sheet, wherever it was edited. */
  sheetValues?: Record<string, number> | undefined
  /** The host's card for a print run step (the slice it made, the print it started); without it the step shows nothing. */
  runCard?: ((p: { stage: 'slice' | 'progress'; run: PrintRun | null; actionable: boolean }) => ReactNode) | undefined
}

// Unchanged blocks keep their identity in the reducer, so a streaming delta repaints only its own block.
// `run` and `replay` are passed for run blocks only, so a new print run repaints its cards and nothing else.
const BlockView = memo(function BlockView({ block, showThinking, approvals, words, parts, run, replay }: { block: Block; showThinking: boolean; approvals: ApprovalHandlers; words?: StepWords | undefined; parts?: PartHandlers | undefined; run?: PrintRun | null | undefined; replay?: boolean | undefined }) {
  switch (block.kind) {
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
    case 'approval': {
      // a host's own card is only for the runtime's own tools (source 'command', or the runtime's builtin flag); a
      // plugin's tool of the same name, or an event with neither, gets the ordinary card
      const Own = block.source === 'command' || block.builtin === true ? approvals.cards?.[block.request.tool] : undefined
      const Card = Own ?? ApprovalCard
      return (
        <Card
          request={block.request}
          resolution={block.resolution}
          actionable={!block.replay}
          onApprove={approvals.onApprove}
          onCancel={approvals.onCancel}
          onEditPlan={approvals.onEditPlan}
          {...(Own ? { run: run ?? null } : {})}
        />
      )
    }
    case 'lookup':
      return <LookupRecord lookup={block.lookup} />
    case 'sheet':
      return <SheetRecord sheet={block.sheet} answer={block.answer} bound={block.bound !== undefined} actionable={!block.replay} values={approvals.sheetValues} onEdit={block.replay ? undefined : approvals.onEditSheet} onConfirm={approvals.onConfirmSheet} onCancel={approvals.onCancelSheet} onOpen={approvals.onOpenSheet} />
    case 'choice': {
      const props: ChoiceCardProps = { askId: block.askId, title: block.title, question: block.question, choices: block.choices, picked: block.picked, actionable: !block.replay, onChoose: approvals.onChoose }
      return approvals.choiceCard?.(props) ?? <ChoiceCard {...props} />
    }
    case 'summary':
      return <Summary title={block.title} rows={block.rows} stopped={block.stopped} ms={block.ms} />
    case 'citations':
      return <Citations items={block.items} />
    case 'error':
      return <ErrorLine message={block.message} code={block.code} />
    case 'run':
      return approvals.runCard?.({ stage: block.stage, run: run ?? null, actionable: replay !== true }) ?? null
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
                <BlockView key={b.id} block={b} showThinking={showThinking} approvals={approvals} words={words} parts={parts} {...(b.kind === 'run' ? { run: runShown(b, transcript.printRun), replay: t.replay } : b.kind === 'approval' && b.builtin === true ? { run: transcript.printRun } : {})} />
              ))}
              {/* a design built step by step keeps its rows, and gets one card after them */}
              {part?.built && parts ? <PartCard part={part} handlers={parts} /> : null}
              {part && parts && done ? <FollowUpChips part={part} handlers={parts} /> : null}
              <UsedLine names={usedNames(t.used, transcript.plugins)} />
            </PilotTurn>
          </Fragment>
        )
      })}
    </>
  )
}
