// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useId, useState } from 'react'
import { Icon } from '@slicerx/ui'
import { RavenWait } from './raven-wait'

export interface ThinkProps {
  text: string
  /** null while the model is still thinking. */
  ms: number | null
  showThinking: boolean
}

/** Reasoning streams open, then folds to one line unless Show thinking is on. */
export function Think({ text, ms, showThinking }: ThinkProps) {
  const bodyId = useId()
  const streaming = ms === null
  // A manual toggle holds until the phase or the Show thinking switch changes.
  const phase = `${streaming ? 'live' : 'done'}:${showThinking ? 'show' : 'hide'}`
  const [manual, setManual] = useState<{ phase: string; open: boolean } | null>(null)
  const auto = streaming || showThinking
  const open = manual !== null && manual.phase === phase ? manual.open : auto
  const label = streaming ? 'Thinking' : ms > 0 ? `Thought for ${(ms / 1000).toFixed(1)}s` : 'Thought'
  return (
    <div className={open ? 'think open' : 'think'}>
      <button type="button" className="think-h" aria-expanded={open} aria-controls={bodyId} onClick={() => setManual({ phase, open: !open })}>
        {streaming ? (
          <RavenWait who="huginn">
            <span className="dot-p" aria-hidden="true" />
          </RavenWait>
        ) : null}
        <span>{label}</span>
        <Icon name="chevron-down" />
      </button>
      <div className="think-b" id={bodyId}>
        {text}
      </div>
    </div>
  )
}
