// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A chat on a model with tool search sends its whole tool catalog on every request, in one fixed order and byte for
// byte as first sent, so the provider's prompt cache holds from turn to turn. The tools mimir uses most load up front
// (SEARCH_CORE); every other tool is deferred, and the model finds it with the provider's tool search. The catalog is
// never edited: a tool the app offers later is appended deferred, and offering or withdrawing a tool mid-chat (a run
// limited to read-only tools, a printer or connector that comes or goes) is a tool change appended to the chat
// (LlmMessage `tools`). Local models and providers without tool search keep their per-turn lists (toolsets.ts), and so
// does a chat on mimir cloud until its proxy has said it takes tool search (LlmClient.toolSearch, runtime.ts).
import type { LlmToolDef } from './provider/types'

/**
 * The tools that load up front, in this order. The core comes from recorded call counts: the 13 tools called most
 * across every recorded run (1350 calls), down to the tie at 35 calls (geom.loft and paint.apply). Every other tool,
 * geom.measure and geom.info among them, is found by search.
 */
export const SEARCH_CORE: readonly string[] = [
  'design.look',
  'geom.extrude',
  'design.plan',
  'design.edit_step',
  'geom.build',
  'design.check',
  'design.undo',
  'geom.array',
  'paint.preview',
  'pilot.sheet',
  'design.new',
  'geom.loft',
  'paint.apply',
]

/** What a chat sends as its tools: the catalog as first sent, and the names the model may call now. */
export interface ToolCatalog {
  /** Every tool the chat declared, in the order sent, each as first sent. Only ever appended to. */
  defs: LlmToolDef[]
  /** The tools offered now: declared and not withdrawn. */
  live: Set<string>
}

/** One tool the app offers this step: its name and, built only when the catalog first takes it, its definition. */
export interface OfferedTool {
  name: string
  def: () => Omit<LlmToolDef, 'deferred'>
}

/**
 * The chat's catalog after this step offers `offered`, and the tool changes that say so. The first step declares every
 * offered tool: SEARCH_CORE first (in its order, loaded), then the rest in their own order (deferred). Later steps
 * keep every definition as it was; a tool not declared yet is appended deferred and added, a declared one offered again
 * is added, and one no longer offered is withdrawn. `catalog` is not changed.
 */
export function catalogStep(catalog: ToolCatalog | undefined, offered: readonly OfferedTool[]): { catalog: ToolCatalog; add: string[]; remove: string[] } {
  const now = new Set(offered.map((t) => t.name))
  if (!catalog) {
    const core = SEARCH_CORE.flatMap((n) => offered.filter((t) => t.name === n))
    const rest = offered.filter((t) => !SEARCH_CORE.includes(t.name))
    const defs = [...core.map((t) => ({ ...t.def() })), ...rest.map((t) => ({ ...t.def(), deferred: true }))]
    return { catalog: { defs, live: now }, add: [], remove: [] }
  }
  const declared = new Set(catalog.defs.map((d) => d.name))
  const fresh = offered.filter((t) => !declared.has(t.name))
  const add = offered.filter((t) => !catalog.live.has(t.name)).map((t) => t.name)
  const remove = [...catalog.live].filter((n) => !now.has(n))
  return { catalog: { defs: [...catalog.defs, ...fresh.map((t) => ({ ...t.def(), deferred: true }))], live: now }, add, remove }
}

/** The definitions that load up front, the part of the catalog the model's reasoning is bound to. */
export function loadedDefs(catalog: ToolCatalog): LlmToolDef[] {
  return catalog.defs.filter((d) => !d.deferred)
}
