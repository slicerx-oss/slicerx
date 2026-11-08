// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Recorded replies for the build eval cases, one JSON file per case id, written only by a live run with recording on.
// Each holds what the model sent back, request by request, and how the run scored, so a replay can check it scores
// the same offline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalStep } from './drive'

export const RECORDINGS_DIR = join(__dirname, 'recordings')

/** The parts of a score a replay must match. */
export interface ScoreSummary {
  pass: boolean
  geometry: boolean
  built: boolean
  refused: boolean
  extra: number
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
