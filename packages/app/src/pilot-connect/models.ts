// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model choices for a person's own key: Auto first (the default), then each model with a rough cost. Auto starts on
// the small model and moves to the larger one for hard parts, and the chat says when it does. mimir cloud has no choice
// (it runs one small model), and a local model server names its own models.
import type { PilotProvider } from './keys'

/** Auto, as saved in the Model setting. */
export const AUTO_MODEL = 'auto'

export interface ModelChoice {
  id: string
  label: string
  cost: string
}

/**
 * huginn's and muninn's models when Auto runs on this provider's key, or null when Auto does not apply. `design` says
 * whether design work goes to muninn: Haiku builds most parts itself (mimir-bench), GPT-6 luna does not.
 */
export function autoPair(provider: PilotProvider): { huginn: string; muninn: string; design: boolean } | null {
  if (provider === 'anthropic') return { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5', design: false }
  if (provider === 'openai') return { huginn: 'gpt-6-luna', muninn: 'gpt-6-sol', design: true }
  return null
}

/** The Model dropdown for a provider, Auto first; empty where there is no dropdown. Never defaults to the priciest model. */
export function modelChoices(provider: PilotProvider): ModelChoice[] {
  if (provider === 'anthropic')
    return [
      { id: AUTO_MODEL, label: 'Auto', cost: 'Haiku, Sonnet for hard parts' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', cost: 'lowest' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', cost: 'medium' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', cost: 'highest' },
    ]
  if (provider === 'openai')
    return [
      { id: AUTO_MODEL, label: 'Auto', cost: 'luna, sol for design and hard parts' },
      { id: 'gpt-6-luna', label: 'GPT-6 luna', cost: 'lowest' },
      { id: 'gpt-6-sol', label: 'GPT-6 sol', cost: 'higher' },
    ]
  return []
}
