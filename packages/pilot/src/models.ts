// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which model a run uses. mimir has two tiers, named after Odin's ravens (design/NAMES.md):
// huginn takes quick looks (check-ins, frame reads, short answers) on a small, fast vision
// model; muninn thinks deeply (diagnosis, tune-from-failure, planning) on the large one.
import type { PilotConfig } from '@slicerx/contracts'

export const HUGINN = 'huginn'
export const MUNINN = 'muninn'
export type Tier = typeof HUGINN | typeof MUNINN

/** The Model setting's default value. */
export const MODEL_AUTOMATIC = 'automatic'
/** How the setting shows the default. */
export const MODEL_AUTOMATIC_LABEL = `Automatic (${HUGINN} for quick looks, ${MUNINN} for deep thinking)`

/** Requests that need deep thinking from the start: diagnosis, tuning a profile, planning. */
const DEEP = /\b(why\b|diagnos|fail(ed|ure|s)?\b|went wrong|what happened|tune|fix (the|my|this)|profile|plan\b|planning|schedule|optimi[sz]e|compare|calibrat|by (tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|settings for)/i

/** Tools whose work needs muninn; a run that reaches one moves to muninn for the rest. */
export const MUNINN_TOOLS: ReadonlySet<string> = new Set([
  'diagnose',
  'kb.troubleshoot',
  'settings.plan',
  'settings.apply',
  'optimize_to_target',
  'compare_setups',
  'schedule',
  'calibrate',
  'resume_from_layer',
  'make_model',
  'text_to_part',
  'cut',
])

/** Failed tool results on huginn before Auto moves the rest of the run to muninn. */
export const STRUGGLE_FAILS = 2

export function tierForPrompt(prompt: string): Tier {
  return DEEP.test(prompt) ? MUNINN : HUGINN
}

/**
 * The model id for a tier. A pinned choice wins. `models` are the ChatGPT plan's tiers (the
 * owner's pick from the plan listing is in pilot.config.example.json). On an API key, billed
 * per token, one model does everything (`config.model`, a small one) unless the person chose
 * Auto, which uses the tiers too.
 */
export function modelFor(config: Pick<PilotConfig, 'model' | 'models' | 'modelChoice' | 'billing' | 'auto'>, tier: Tier): string {
  if (config.modelChoice && config.modelChoice !== MODEL_AUTOMATIC) return config.modelChoice
  if (config.billing === 'key' && !config.auto) return config.model
  return config.models?.[tier] ?? config.model
}

const LABELS: Record<string, string> = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'gpt-6-luna': 'GPT-6 luna',
  'gpt-6-sol': 'GPT-6 sol',
}

/** How the chat names a model. */
export function modelLabel(id: string): string {
  return LABELS[id] ?? id
}
