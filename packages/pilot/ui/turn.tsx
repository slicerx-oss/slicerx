// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ReactNode } from 'react'
import type { PilotAttachment } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'
import { ASSISTANT_NAME } from '../src/name'
import { AttachmentChip } from './attachments'

/** The person's message: a raised bubble on the right with the prompt glyph, and the files that ride on it above. */
export function Bubble({ text, where, attachments = [] }: { text: string; where?: string | null; attachments?: readonly PilotAttachment[] }) {
  return (
    <div className="turn-user">
      {where ? <span className="where">{where}</span> : null}
      {attachments.length ? (
        <div className="att-row" aria-label="Attached">
          {attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      ) : null}
      <div className="bubble">
        <span className="pg" aria-hidden="true">
          {'❯'}
        </span>
        <span>{text}</span>
      </div>
    </div>
  )
}

/** mimir's reply: a named label, then its blocks in order. */
export function PilotTurn({ children }: { children?: ReactNode }) {
  return (
    <div className="turn-pilot">
      <div className="who">
        <Icon name="pilot" />
        <span>{ASSISTANT_NAME}</span>
      </div>
      {children}
    </div>
  )
}
