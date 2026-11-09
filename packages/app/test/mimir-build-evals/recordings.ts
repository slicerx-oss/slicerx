// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Recorded replies for the build eval cases, one JSON file per case id, written only by a live run with recording on.
// Each holds what the model sent back, request by request, and how the run scored, so a replay can check it scores
// the same offline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalStep } from './drive'
import type { CaseScore } from './score'

export const RECORDINGS_DIR = join(__dirname, 'recordings')

/** Whether each check of the geometry passed, so a known failure pins which one fails. A run that built nothing has only ops. */
export interface ScoreChecks {
  ops: boolean
  watertight?: boolean
  bodies?: boolean
  minWall?: boolean
  bedFit?: boolean
  sizes?: boolean
  hook?: boolean
}

/** The parts of a score a replay must match. */
export interface ScoreSummary {
  pass: boolean
  geometry: boolean
  built: boolean
  refused: boolean
  extra: number
  checks: ScoreChecks
}

export function summarize(s: CaseScore): ScoreSummary {
  const checks: ScoreChecks = { ops: s.ops.pass }
  for (const k of ['watertight', 'bodies', 'minWall', 'bedFit', 'sizes', 'hook'] as const) if (s[k]) checks[k] = s[k]!.pass
  return { pass: s.pass, geometry: s.geometry, built: s.built, refused: s.refused, extra: s.extra, checks }
}

export interface BuildRecording {
  model: string
  provider: string
  capturedAt: string
  steps: EvalStep[]
  score: ScoreSummary
}

export function loadRecording(id: string, dir = RECORDINGS_DIR): BuildRecording | null {
  const path = join(dir, `${id}.json`)
  if (!existsSync(path)) return null
  const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildRecording>
  if (!v.model || !v.provider || !v.capturedAt || !Array.isArray(v.steps) || !v.steps.length || !v.score) throw new Error(`${path}: a recording needs model, provider, capturedAt, steps and score`)
  return v as BuildRecording
}

export function saveRecording(id: string, rec: BuildRecording, dir = RECORDINGS_DIR): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(rec, null, 1)}\n`)
}

/**
 * Saves a live run as the case's recording; returns whether it did. A run with no replies, one that ended on an error
 * (the drive says why a run stopped early) and any run once the budget stopped (`stopped`) are not what the model would
 * do, so none of them is saved: a replay of one would pin a failure the model never made.
 */
export function recordLive(id: string, run: { steps: EvalStep[]; score: CaseScore; error?: string }, from: { model: string; provider: string; stopped: boolean }, dir = RECORDINGS_DIR): boolean {
  if (!run.steps.length || run.error || from.stopped) return false
  saveRecording(id, { model: from.model, provider: from.provider, capturedAt: new Date().toISOString(), steps: run.steps, score: summarize(run.score) }, dir)
  return true
}

/**
 * Writes `next` as a recording's score and touches nothing else (model, steps and capture time stay as captured). It
 * refuses when a field the recording already has differs from `next`, so a replay that no longer scores as it did live
 * is not written over.
 */
export function refreshScore(id: string, next: ScoreSummary, dir = RECORDINGS_DIR): void {
  const rec = loadRecording(id, dir)
  if (!rec) throw new Error(`no recording for ${id} in ${dir}`)
  const old = rec.score as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(next)) if (k in old && JSON.stringify(old[k]) !== JSON.stringify(v)) throw new Error(`${id}: replay scores ${k} ${JSON.stringify(v)}, recorded ${JSON.stringify(old[k])}`)
  saveRecording(id, { ...rec, score: next }, dir)
}
