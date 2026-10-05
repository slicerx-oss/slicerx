// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Fragment, memo } from 'react'
import type { ApprovalRequest } from '@slicerx/contracts'
import { ApprovalCard } from './approval-card'
import { Citations } from './citations'
import { Diff } from './diff'
import { ErrorLine, PermLine, PlanList, PluginsLoading } from './notes'
import type { Block, Transcript } from './reduce'
import { Say } from './say'
import { Summary } from './summary'
import { Think } from './think'
import { ToolGroup } from './tool-group'
import { Bubble, PilotTurn } from './turn'

export interface ApprovalHandlers {
  onApprove: (request: ApprovalRequest, opts: { bedClear: boolean }) => Promise<void>
  onCancel: (request: ApprovalRequest) => Promise<void>
  onEditPlan?: ((request: ApprovalRequest) => void) | undefined
}

// Unchanged blocks keep their identity in the reducer, so a streaming delta repaints only its own block.
const BlockView = memo(function BlockView({ block, showThinking, approvals }: { block: Block; showThinking: boolean; approvals: ApprovalHandlers }) {
  switch (block.kind) {
    case 'plugins':
      return <PluginsLoading plugins={block.plugins} />
    case 'think':
      return <Think text={block.text} ms={block.ms} showThinking={showThinking} />
    case 'say':
      return <Say text={block.text} streaming={block.streaming} />
    case 'plan':
      return <PlanList steps={block.steps} />
    case 'tools':
      return <ToolGroup rows={block.rows} />
    case 'diff':
      return <Diff diff={block.diff} />
    case 'perm':
      return <PermLine mode={block.mode} message={block.message} />
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
    case 'summary':
      return <Summary title={block.title} rows={block.rows} stopped={block.stopped} ms={block.ms} />
    case 'citations':
      return <Citations items={block.items} />
    case 'error':
      return <ErrorLine message={block.message} />
  }
})

/** Every turn in order: the bubble, then mimir's reply. */
export function TranscriptView({ transcript, showThinking, approvals }: { transcript: Transcript; showThinking: boolean; approvals: ApprovalHandlers }) {
  return (
    <>
      {transcript.turns.map((t) => (
        <Fragment key={t.id}>
          {t.user !== null ? <Bubble text={t.user} where={t.where} /> : null}
          <PilotTurn>
            {t.blocks.map((b) => (
              <BlockView key={b.id} block={b} showThinking={showThinking} approvals={approvals} />
            ))}
          </PilotTurn>
        </Fragment>
      ))}
    </>
  )
}
