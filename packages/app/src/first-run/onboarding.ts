// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The setup steps and the onboarding version, with no dependencies: the shell reads them at launch to
// decide whether setup opens again, so they stay out of the setup chunk. The flow itself is model.ts.
import type { FirstRunState } from '@slicerx/contracts'

/** The theme first, so the rest of setup shows in it; then the printer, the slicer the person comes from (stored as the look choice), what the plate tab opens in (editions with modeling tools), and an optional mimir step. */
export const SETUP_STEPS = ['theme', 'printer', 'look', 'open', 'mimir'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

/**
 * The onboarding version. Raise it whenever a release changes onboarding: add a step, or change what
 * one asks. A finished setup records the version it ran; see `onboardingRerun` for what a raise does.
 * 1: printer and slicer (through 0.2.2). 2: the theme step and the open step (0.2.3). 3: the slicer step asks for
 * the settings mode, which the chip at the top of the Slice sidebar changes afterwards. 4: the slicer step asks how
 * auto slice works (Auto by size, Always, Off).
 */
export const ONBOARDING_VERSION = 4

/** The onboarding version each step arrived in. After alpha, a person who finished an older onboarding sees only the newer steps. */
export const STEP_SINCE: Readonly<Record<SetupStep, number>> = { theme: 2, printer: 1, look: 4, open: 2, mimir: 1 }

/** Release stages that make everyone go through onboarding again when it changes. */
const RERUN_ALL_STAGES: readonly string[] = ['pre-alpha', 'alpha']

/**
 * Whether setup opens by itself at launch because onboarding changed since the person last went through
 * it. In pre-alpha and alpha everyone runs all of it again, prefilled from their settings; after alpha
 * only the steps added since their version show. Null when their record is current, or when there is no
 * record (a fresh install opens setup anyway).
 */
export function onboardingRerun(stage: string, fr: FirstRunState | null): { since?: number } | null {
  if (!fr) return null
  const seen = fr.version ?? 1
  if (seen >= ONBOARDING_VERSION) return null
  return RERUN_ALL_STAGES.includes(stage) ? {} : { since: seen }
}

