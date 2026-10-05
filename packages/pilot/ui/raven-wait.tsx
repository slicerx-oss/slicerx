// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ReactNode } from 'react'
import { Raven } from '@slicerx/ui'

/** Tools that read the knowledge base or what the project remembers: muninn's work, not huginn's. */
export function isRecall(tool: string): boolean {
  return tool.startsWith('kb.') || tool.startsWith('project.')
}

/**
 * A wait that runs past 1.2 s turns into a raven beating its wing: huginn while the model reasons,
 * muninn while it recalls. Shorter waits keep the plain cue.
 */
export function RavenWait({ who, children }: { who: 'huginn' | 'muninn'; children: ReactNode }) {
  return (
    <span className="raven-wait" title={who === 'huginn' ? 'huginn, thinking' : 'muninn, recalling'}>
      <span className="raven-wait-cue">{children}</span>
      <Raven size={18} flap facing={who === 'huginn' ? 'right' : 'left'} className="raven-wait-bird" />
    </span>
  )
}
