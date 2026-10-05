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

export function tierForPrompt(prompt: string): Tier {
  return DEEP.test(prompt) ? MUNINN : HUGINN
}

/**
 * The model id for a tier. A pinned choice wins. `models` are the ChatGPT plan's tiers (the
 * owner's pick from the plan listing is in pilot.config.example.json). On an API key, billed
 * per token, one model does everything: `config.model`, which should be a small one.
 */
export function modelFor(config: Pick<PilotConfig, 'model' | 'models' | 'modelChoice' | 'billing'>, tier: Tier): string {
  if (config.modelChoice && config.modelChoice !== MODEL_AUTOMATIC) return config.modelChoice
  if (config.billing === 'key') return config.model
  return config.models?.[tier] ?? config.model
}
