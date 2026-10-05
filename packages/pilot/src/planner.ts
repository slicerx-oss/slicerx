// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings planner mimir calls for live settings evaluation. Deterministic,
// no model call, budget 50 ms. The shape mirrors what packages/settings exports.
import type { PilotMachine, PlanAdvice, PlanClamp, PlanRefusal, PrintConfig, SettingValue } from '@slicerx/contracts'

export interface PlannedChange {
  key: string
  label: string
  section: 'process' | 'filament' | 'printer'
  before: SettingValue | null
  after: SettingValue
  unit?: string
  reason: string
  sources: string[]
  /** `ask` for a guarded key outside the filament's documented range: applying it needs approval. */
  approval?: 'none' | 'ask'
  origin?: string
  goal?: string
}

export interface PlanResult {
  from: PilotMachine
  to: PilotMachine
  changes: PlannedChange[]
  warnings: string[]
  /** Hard stops (abrasive filament on a soft nozzle). No changes while any exist. */
  blockers?: string[]
  questions?: string[]
  caveats?: { text: string; sources: string[] }[]
  advice?: PlanAdvice[]
  clamps?: PlanClamp[]
  refused?: PlanRefusal[]
  /** What a goal conflict gave up, for the reply. */
  tellUser?: string[]
  computedMs?: number
}

export interface PlanOptions {
  /** The config in use, so `before` values and nozzle rescaling are exact. */
  base?: PrintConfig
  /** Goals from kb.intent, by knowledge/intents id. */
  goals?: { id: string; level?: string }[]
}

export interface SettingsPlanner {
  plan(from: PilotMachine, to: PilotMachine, current?: Record<string, SettingValue>, opts?: PlanOptions): PlanResult
}
