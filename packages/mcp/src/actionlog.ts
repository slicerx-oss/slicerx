// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Append-only JSONL log of every tool call and approval decision. Tokens,
// file contents and credentials are never written; inputs appear only as a hash.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Decision = 'read' | 'allowed' | 'approved' | 'denied' | 'off' | 'pending' | 'expired' | 'failed' | 'needs_person' | 'refused'

export interface ActionEntry {
  ts: string
  tool: string
  permission: string
  decision: Decision
  /** Who decided: the policy file, the user through elicitation, or the client through slicerx_approve. */
  by?: 'policy' | 'user' | 'client' | 'person'
  request_id?: string
  printer_id?: string
  /** SHA-256 of the canonical JSON of the input. */
  input_hash: string
  ok?: boolean
  summary?: string
}

export interface ActionLog {
  readonly path: string
  append(entry: Omit<ActionEntry, 'ts'>): void
  recent(limit: number): ActionEntry[]
}

export function createActionLog(path: string, now: () => Date = () => new Date()): ActionLog {
  return {
    path,
    append(entry) {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify({ ts: now().toISOString(), ...entry })}\n`)
    },
    recent(limit) {
      if (!existsSync(path)) return []
      const lines = readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean)
      return lines.slice(-limit).map((l) => JSON.parse(l) as ActionEntry)
    },
  }
}
