// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useSyncExternalStore, type ReactNode } from 'react'
import { assistantBrand, onAssistantBrand } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'
import { Raven, RuneRing } from '@slicerx/ui/raven'

/** Tools that read the knowledge base or what the project remembers: muninn's work, not huginn's. */
export function isRecall(tool: string): boolean {
  return tool.startsWith('kb.') || tool.startsWith('project.')
}

/**
 * A wait that runs past 1.2 s turns into a raven in a turning ring of runes: huginn while the model reasons, the
 * ring turning with the clock; muninn while it recalls, the ring turning back. Shorter waits keep the plain cue.
 * The ring hangs over the cue's own slot, so nothing beside it moves when it comes in.
 */
export function RavenWait({ who, children }: { who: 'huginn' | 'muninn'; children: ReactNode }) {
  const brand = useSyncExternalStore(onAssistantBrand, assistantBrand, assistantBrand)
  if (brand.icon !== 'builtin:mimir') return <span className="raven-wait" title={`${brand.name}, ${who === 'huginn' ? 'thinking' : 'recalling'}`} data-who={who}>
    <span className="raven-wait-cue">{children}</span>
    <span className="raven-wait-bird"><Icon name="mimir" size={24} /></span>
  </span>
  return (
    <span className="raven-wait" title={who === 'huginn' ? 'huginn, thinking' : 'muninn, recalling'} data-who={who}>
      <span className="raven-wait-cue">{children}</span>
      <span className="raven-wait-bird">
        <RuneRing size={34} reverse={who === 'muninn'} />
        <Raven size={16} flap facing={who === 'huginn' ? 'right' : 'left'} />
      </span>
    </span>
  )
}
