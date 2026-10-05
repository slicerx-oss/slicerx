// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ReactNode } from 'react'
import { Icon } from '@slicerx/ui'
import { ASSISTANT_NAME } from '../src/name'

/** The person's message: a raised bubble on the right with the prompt glyph. */
export function Bubble({ text, where }: { text: string; where?: string | null }) {
  return (
    <div className="turn-user">
      {where ? <span className="where">{where}</span> : null}
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
