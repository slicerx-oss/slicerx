// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Cmd+K command registry. Every workspace registers here, and Pilot sees
// commands that carry a `tool` as `app.<id>` tools with the same permission class.
import type { CommandSpec, JsonSchema, ToolSpec } from '@slicerx/contracts'
import { useSyncExternalStore } from 'react'
import { scoreCommand } from './fuzzy'

const commands = new Map<string, CommandSpec>()
const listeners = new Set<() => void>()
let snapshot: readonly CommandSpec[] = []

function emit(): void {
  snapshot = [...commands.values()]
  for (const l of listeners) l()
}

/** Adds or replaces a command. Returns a function that removes it. */
export function registerCommand(spec: CommandSpec): () => void {
  commands.set(spec.id, spec)
  emit()
  return () => {
    if (commands.get(spec.id) === spec) {
      commands.delete(spec.id)
      emit()
    }
  }
}

export function registerCommands(specs: readonly CommandSpec[]): () => void {
  const offs = specs.map(registerCommand)
  return () => {
    for (const off of offs) off()
  }
}

export function getCommand(id: string): CommandSpec | undefined {
  return commands.get(id)
}

export function listCommands(): readonly CommandSpec[] {
  return snapshot
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useCommands(): readonly CommandSpec[] {
  return useSyncExternalStore(subscribe, listCommands, listCommands)
}

export function isEnabled(c: CommandSpec): boolean {
  return c.enabled ? c.enabled() : true
}

export interface Match {
  command: CommandSpec
  score: number
}

/** Enabled commands matching `query`, best first. Ties keep registration order. */
export function searchCommands(query: string, list: readonly CommandSpec[] = snapshot): Match[] {
  const q = query.trim()
  const out: Match[] = []
  for (const command of list) {
    if (!isEnabled(command)) continue
    const score = q ? scoreCommand(q, command.title, command.keywords) : 0
    if (score >= 0) out.push({ command, score })
  }
  if (q) out.sort((a, b) => b.score - a.score)
  return out
}

export type RunResult = { ok: true } | { ok: false; reason: 'unknown' | 'disabled' | 'failed'; message: string }

export async function runCommand(id: string, input?: unknown): Promise<RunResult> {
  const c = commands.get(id)
  if (!c) return { ok: false, reason: 'unknown', message: `No command ${id}` }
  if (!isEnabled(c)) return { ok: false, reason: 'disabled', message: `${c.title} is not available right now` }
  try {
    await c.run(input)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
}

const EMPTY_SCHEMA: JsonSchema = { type: 'object', properties: {} }

/** Commands Pilot may call, as tool specs (`app.<id>`). */
export function commandTools(): ToolSpec[] {
  const out: ToolSpec[] = []
  for (const c of snapshot) {
    if (!c.tool) continue
    const schema = c.tool.inputSchema
    out.push({
      name: `app.${c.id.replace(/[^a-z0-9_]/gi, '_')}`,
      version: '1.0.0',
      description: c.title,
      inputSchema: schema && schema['type'] === 'object' ? (schema as JsonSchema) : EMPTY_SCHEMA,
      permission: c.tool.permission,
      source: 'command',
    })
  }
  return out
}

/** Resolves an `app.<id>` tool name back to its command id. */
export function commandIdForTool(tool: string): string | undefined {
  if (!tool.startsWith('app.')) return undefined
  const key = tool.slice(4)
  for (const c of snapshot) if (c.tool && c.id.replace(/[^a-z0-9_]/gi, '_') === key) return c.id
  return undefined
}
