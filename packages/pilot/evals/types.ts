// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ApprovalRequest, ApprovalVerifier, DemoFleet, PermissionPolicy, PilotEvent, PilotMachine } from '@slicerx/contracts'
import type { ScriptStep } from '../src/provider/scripted'
import type { Audit, EvalHosts, EvalObject } from './harness'

export type ScenarioGroup = 'showcase' | 'adversarial' | 'switch' | 'knowledge' | 'intent' | 'skill'

export interface SettingExpectation {
  key: string
  value?: number | string | boolean
  min?: number
  max?: number
  /** Absolute tolerance for numeric `value`. */
  tol?: number
}

export interface ArgCheck {
  tool: string
  label: string
  check(input: Record<string, unknown>): boolean
}

export interface Expectation {
  /** Each must be called at least once. */
  tools?: string[]
  /** At least one tool from each group must be called. */
  anyOf?: string[][]
  /** Must not run to a successful result. Attempts that the gate stops cost a little precision. */
  forbidden?: string[]
  args?: ArgCheck[]
  settings?: SettingExpectation[]
  citations?: boolean
  /** Host side effects that must happen, approved: `upload:bay-2`, `start:bay-2`. */
  sideEffects?: string[]
  /** No host side effect may happen at all. */
  noSideEffects?: boolean
  /** Event types that must appear, such as `permission_note`. */
  events?: PilotEvent['type'][]
  /** The final reply must match each of these. */
  reply?: RegExp[]
  /** At least this many images (camera frames) must reach the model in one request. */
  imagesToModel?: number
  /** No approval card may be shown (a change refused by its limits never reaches the user). */
  noApprovals?: boolean
  maxToolCalls?: number
}

export interface Scenario {
  id: string
  title: string
  group: ScenarioGroup
  prompt: string
  machine: PilotMachine
  objects: EvalObject[]
  policy?: PermissionPolicy
  fleet?: (f: DemoFleet) => DemoFleet
  /** The simulated user's answer to an approval card. Default: deny. */
  approve?: (req: ApprovalRequest) => boolean
  /**
   * Optional host services the scenario's skills need (fakes in evals/fakes.ts).
   * Fakes with side effects verify tokens with `broker` inside `trackSideEffect`, so the audit sees them.
   */
  hosts?: (env: { broker: ApprovalVerifier; audit: Audit }) => EvalHosts
  /** Stored frames the printers' cameras return, by printer id (evals/frames). */
  frames?: Record<string, string>
  /** For `switch` scenarios: run switchMachine from `machine` to this instead of a chat turn. */
  switchTo?: PilotMachine
  /** Replay script: what a model is expected (or, for adversarial cases, tricked) to do. */
  script: ScriptStep[]
  expect: Expectation
}

export interface ScoreBreakdown {
  tools: number
  args: number
  settings: number
  citations: number
  efficiency: number
  total: number
  pass: boolean
  unapprovedSideEffects: number
  notes: string[]
}

export interface RunRecord {
  scenario: string
  group: ScenarioGroup
  mode: 'replay' | 'live'
  model: string
  run: number
  score: ScoreBreakdown
  toolCalls: number
  ms: number
  inputTokens: number
  outputTokens: number
  calls: string[]
  reply: string
  error?: string
}
