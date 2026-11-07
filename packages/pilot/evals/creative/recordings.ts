// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Recorded replies for the creative prompts, one JSON file per prompt id. A file is either waiting for a live run to
// capture it, or holds what a model sent back in a live run (`cli.ts --mode live --record`), request by request. Only
// the live capture path writes a recording; nothing in it is written by hand.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScriptStepData } from '../../src/provider/scripted'

export const RECORDINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'recordings')

export interface PendingRecording {
  status: 'to-capture'
}

export interface CapturedRecording {
  status: 'recorded'
  /** The model and provider that answered. */
  model: string
  provider: string
  /** When the live run captured it, ISO time. */
  capturedAt: string
  /** One step per provider request: the reply text and the tool calls with their arguments. */
  steps: ScriptStepData[]
  /**
   * Captured with the default answer on (run.ts DEFAULT_ANSWER): when the model asked a question, the steps after it
   * answer the default answer, so a replay sends it too. Recordings from before the default answer leave it out.
   */
  defaultAnswer?: boolean
}

export type Recording = PendingRecording | CapturedRecording

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads a recording file and checks its shape; a missing file reads as waiting for capture. */
export function parseRecording(text: string, where = 'recording'): Recording {
  const v: unknown = JSON.parse(text)
  if (!isObj(v)) throw new Error(`${where}: not a JSON object`)
  if (v['status'] === 'to-capture') return { status: 'to-capture' }
  if (v['status'] !== 'recorded') throw new Error(`${where}: status must be "to-capture" or "recorded"`)
  for (const k of ['model', 'provider', 'capturedAt'] as const) if (typeof v[k] !== 'string' || !v[k]) throw new Error(`${where}: a recorded reply needs ${k}`)
  if (!Array.isArray(v['steps']) || !v['steps'].length) throw new Error(`${where}: a recorded reply needs at least one step`)
  const steps: ScriptStepData[] = v['steps'].map((s, i) => {
    if (!isObj(s)) throw new Error(`${where}: step ${i + 1} is not an object`)
    const step: ScriptStepData = {}
    if (typeof s['text'] === 'string') step.text = s['text']
    if (typeof s['reasoning'] === 'string') step.reasoning = s['reasoning']
    if (s['calls'] !== undefined) {
      if (!Array.isArray(s['calls'])) throw new Error(`${where}: step ${i + 1} calls must be a list`)
      step.calls = s['calls'].map((c, k) => {
        if (!isObj(c) || typeof c['name'] !== 'string' || !isObj(c['args'])) throw new Error(`${where}: step ${i + 1} call ${k + 1} needs a name and args`)
        return { name: c['name'], args: c['args'] }
      })
    }
    return step
  })
  if (v['defaultAnswer'] !== undefined && typeof v['defaultAnswer'] !== 'boolean') throw new Error(`${where}: defaultAnswer must be true or false`)
  const rec: CapturedRecording = { status: 'recorded', model: String(v['model']), provider: String(v['provider']), capturedAt: String(v['capturedAt']), steps }
  if (v['defaultAnswer'] === true) rec.defaultAnswer = true
  return rec
}

export function recordingPath(id: string, dir = RECORDINGS_DIR): string {
  return join(dir, `${id}.json`)
}

export function loadRecording(id: string, dir = RECORDINGS_DIR): Recording {
  const path = recordingPath(id, dir)
  if (!existsSync(path)) return { status: 'to-capture' }
  return parseRecording(readFileSync(path, 'utf8'), path)
}

export function saveRecording(id: string, rec: CapturedRecording, dir = RECORDINGS_DIR): void {
  writeFileSync(recordingPath(id, dir), `${JSON.stringify(rec, null, 1)}\n`)
}
