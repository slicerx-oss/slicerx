// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The setup flow as a pure state machine: the screens, Back and Skip, leaving, and what is written. Also
// when a changed onboarding runs again. React-free so every path is unit tested. See docs/first-run.md.
import type { FirstRunState, FirstRunStep, LookAndFeelChoice, LookId } from '@slicerx/contracts'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { ONBOARDING_VERSION, STEP_SINCE, type SetupStep } from './onboarding'

export { ONBOARDING_VERSION, SETUP_STEPS, STEP_SINCE, onboardingRerun, type SetupStep } from './onboarding'

/** The screens without the mimir step, for editions without mimir and for people already connected. */
export const BASE_STEPS: readonly SetupStep[] = ['theme', 'printer', 'look']

/** The screens for an edition: the open step only where the edition has modeling tools, mimir where it is offered. With `since`, only the steps newer than that onboarding version. */
export function setupSteps(o: { cad: boolean; mimir: boolean; since?: number }): SetupStep[] {
  const all: SetupStep[] = [...BASE_STEPS, ...(o.cad ? (['open'] as const) : []), ...(o.mimir ? (['mimir'] as const) : [])]
  if (o.since === undefined) return all
  const newer = all.filter((s) => STEP_SINCE[s] > (o.since as number))
  return newer.length ? newer : all
}

export type OpenIn = 'slice' | 'design'

export const STEP_TITLES: Readonly<Record<SetupStep, string>> = {
  theme: 'Theme',
  printer: 'Printer',
  look: 'Your slicer',
  open: 'Opens in',
  mimir: ASSISTANT_NAME,
}

/** Any stored or requested step name, mapped onto the screens in `steps`. Old names (welcome, cad, done) open the first screen. */
export function normalizeStep(step: string | null | undefined, steps: readonly SetupStep[] = BASE_STEPS): SetupStep {
  const first = steps[0] ?? 'theme'
  if (step === 'pilot') return steps.includes('mimir') ? 'mimir' : first
  if (step && (steps as readonly string[]).includes(step)) return step as SetupStep
  if (step === 'open' && steps.includes('look')) return 'look'
  return first
}

/** What the stored state knows about the printer. No secrets, ever. */
export interface SetupPrinter {
  printerId: string
  brand: string
  model: string
  nozzle: string
  connection: string
  /** `verified` after a passing test, `unverified` when saved without one, `none` for no connection. */
  state: 'verified' | 'unverified' | 'none'
  filamentSystem: string
}

export interface FlowState {
  step: SetupStep
  /** The screens this run shows, in order. */
  steps: readonly SetupStep[]
  /** Steps visited, for Back. */
  trail: SetupStep[]
  look: LookAndFeelChoice
  /** The choice when the slicer screen opened, so Back from it restores the app as it was. */
  lookAtEntry: LookAndFeelChoice | null
  /** True once the person picked a slicer; only then is the look kept on leaving. */
  lookPicked: boolean
  printer: SetupPrinter | null
  /** What the plate tab opens in, from the open step. Written when the flow finishes, like the look. */
  openIn: OpenIn
  /** The Escape dialog is open. */
  confirmLeave: boolean
  /** Set when the flow ends: finished or left. */
  closed: 'finished' | 'left' | null
  /** Ended by Skip, use defaults. */
  skippedAll?: boolean
}

export type FlowEvent =
  | { type: 'skip-all' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'skip' }
  | { type: 'goto'; step: SetupStep }
  | { type: 'pick-look'; look: LookAndFeelChoice }
  | { type: 'pick-open'; openIn: OpenIn }
  | { type: 'printer-saved'; printer: SetupPrinter }
  | { type: 'no-printer' }
  | { type: 'request-leave' }
  | { type: 'stay' }
  | { type: 'leave' }
  | { type: 'finish' }

export function initialFlow(step: SetupStep, look: LookAndFeelChoice, printer: SetupPrinter | null = null, steps: readonly SetupStep[] = BASE_STEPS, openIn: OpenIn = 'slice'): FlowState {
  return { step: steps.includes(step) ? step : (steps[0] ?? 'theme'), steps, trail: [], look, lookAtEntry: step === 'look' ? look : null, lookPicked: false, printer, openIn, confirmLeave: false, closed: null }
}

function go(s: FlowState, step: SetupStep): FlowState {
  if (step === s.step) return s
  return { ...s, step, trail: [...s.trail, s.step], lookAtEntry: step === 'look' ? s.look : s.lookAtEntry }
}

/** Forward from a step: the next screen, or the end of the flow after the last one. */
function forward(s: FlowState): FlowState {
  const i = s.steps.indexOf(s.step)
  const next = s.steps[i + 1]
  return next ? go(s, next) : { ...s, closed: 'finished' }
}

export function reduceFlow(s: FlowState, e: FlowEvent): FlowState {
  if (s.closed) return s
  switch (e.type) {
    case 'skip-all':
      // Defaults: the preset in effect, no printer, the demo plate.
      return { ...s, printer: null, closed: 'finished', skippedAll: true }
    case 'next':
    case 'skip':
      return forward(s)
    case 'goto':
      return go(s, e.step)
    case 'back': {
      const prev = s.trail[s.trail.length - 1]
      if (!prev) return s
      // Leaving the slicer screen backwards puts the look back the way it was.
      const look = s.step === 'look' && s.lookAtEntry ? s.lookAtEntry : s.look
      return { ...s, step: prev, trail: s.trail.slice(0, -1), look, lookPicked: s.step === 'look' ? false : s.lookPicked }
    }
    case 'pick-look':
      return { ...s, look: e.look, lookPicked: true }
    case 'pick-open':
      return { ...s, openIn: e.openIn }
    case 'printer-saved':
      return forward({ ...s, printer: e.printer })
    case 'no-printer':
      return forward({ ...s, printer: null })
    case 'request-leave':
      return { ...s, confirmLeave: true }
    case 'stay':
      return { ...s, confirmLeave: false }
    case 'leave':
      return { ...s, confirmLeave: false, closed: 'left' }
    case 'finish':
      return { ...s, closed: 'finished' }
  }
}

/** "Step 1 of 2, Printer", for the header and the live region. */
export function stepLabel(step: SetupStep, steps: readonly SetupStep[] = BASE_STEPS): { index: number; total: number; text: string } {
  const index = steps.indexOf(step) + 1
  return { index, total: steps.length, text: `Step ${index} of ${steps.length}, ${STEP_TITLES[step]}` }
}

/** Fill of the progress rail, 0 to 1: full on the last screen. */
export function progress(step: SetupStep, steps: readonly SetupStep[] = BASE_STEPS): number {
  return (steps.indexOf(step) + 1) / steps.length
}

/** The step as stored. The contract has no mimir step; a run left there resumes on the step before it, one Next away. */
export function contractStep(step: SetupStep, steps: readonly SetupStep[] = BASE_STEPS): FirstRunStep {
  if (step !== 'mimir') return step
  return steps.includes('open') ? 'open' : 'look'
}

/**
 * What the flow writes when it closes. Finishing records completion and the printer. Leaving
 * writes nothing new except the look, and only when the person had picked one (it was applied
 * live and stays). Returns null for the look when nothing about it should change.
 */
export function outcome(s: FlowState, now: string, prior: FirstRunState | null): { firstRun: FirstRunState; look: LookAndFeelChoice | null; printerId: string | null; openIn: OpenIn | null; noPrinter?: true } {
  if (s.closed === 'finished') {
    return {
      // Skip, use defaults with no printer of their own is Slice without a printer: launch stops asking for one.
      ...(s.skippedAll && !prior?.printerId ? { noPrinter: true as const } : {}),
      firstRun: { completedAt: now, step: 'done', look: s.look, printerId: s.printer?.printerId ?? prior?.printerId ?? null, version: ONBOARDING_VERSION },
      look: s.look,
      printerId: s.printer?.printerId ?? null,
      // Skip, use defaults keeps the default; finishing writes the choice when the open step was offered.
      openIn: s.steps.includes('open') ? s.openIn : null,
    }
  }
  const look = s.lookPicked ? s.look : null
  return {
    // Leaving counts as having seen this onboarding: a rerun does not come back at the next launch. Setup stays open to finish from Settings.
    firstRun: { completedAt: prior?.completedAt ?? null, step: contractStep(s.step, s.steps), look: look ?? prior?.look ?? s.look, printerId: prior?.printerId ?? null, version: ONBOARDING_VERSION },
    look,
    printerId: null,
    openIn: null,
  }
}

/** A choice for a preset id that keeps the person's control overrides when they only switch presets. */
export function choose(id: LookId, current: LookAndFeelChoice): LookAndFeelChoice {
  return current.overrides ? { id, overrides: current.overrides } : { id }
}
