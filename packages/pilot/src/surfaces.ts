// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which tools mimir offers a model, by where it runs. A cloud model gets every tool the runtime has. A local model has
// a small context (see context.ts) where the tool schemas are most of the request, so it gets only the tools its
// surface uses: the docked chat keeps its chat tools and text_to_part as the way into a design, without make_model.
// An edition can also switch whole tool groups off (ai.brain.tools); a switch only ever takes tools away.
import type { PilotConfig } from '@slicerx/contracts'

/** Where a mimir runs: the docked chat beside the plate. */
export type ToolSurface = 'dock'

/** Whether a config runs a local model (Ollama or LM Studio through their OpenAI-compatible server). */
export function isLocalModel(config: Pick<PilotConfig, 'provider'>): boolean {
  return config.provider === 'openai-compatible'
}

/** Tools a local model does not get, per surface. Everything else the surface has stays. */
const LOCAL_LEAVE_OUT: Record<ToolSurface, ReadonlySet<string>> = {
  // text_to_part is the dock's one way into a design; make_model's schema alone is about 1,700 tokens
  dock: new Set(['make_model']),
}

/** The tools a model on `surface` is offered: all of `tools` for a cloud model, the surface's own set for a local one. */
export function surfaceTools<T extends { name: string }>(surface: ToolSurface, local: boolean, tools: readonly T[]): T[] {
  if (!local) return [...tools]
  const out = LOCAL_LEAVE_OUT[surface]
  return tools.filter((t) => !out.has(t.name))
}

/** Tool groups an edition can switch off (ai.brain.tools). Core tools have no switch. */
export const TOOL_GROUPS = ['design', 'slicing', 'printers', 'watch', 'paint', 'web'] as const
/** The group a tool belongs to; `core` is every tool no switch reaches. */
export type ToolGroup = (typeof TOOL_GROUPS)[number] | 'core'
/** An edition's switches: false turns a group off; true or a missing group leaves it as it is. */
export type ToolGroups = Partial<Record<(typeof TOOL_GROUPS)[number], boolean>>

const GROUP_OF: Record<string, ToolGroup> = {
  // making and changing parts
  make_model: 'design',
  text_to_part: 'design',
  'parts.lookup': 'design',
  cut: 'design',
  hollow: 'design',
  emboss: 'design',
  threads_and_fits: 'design',
  scale_with_tolerance: 'design',
  fit_check: 'design',
  // preparing and slicing a plate
  slice: 'slicing',
  estimate: 'slicing',
  arrange: 'slicing',
  orient: 'slicing',
  orientation_search: 'slicing',
  supports: 'slicing',
  walls: 'slicing',
  smart_layer: 'slicing',
  region_modifiers: 'slicing',
  optimize_to_target: 'slicing',
  compare_setups: 'slicing',
  risk_report: 'slicing',
  gcode_inspect: 'slicing',
  mesh_analyze: 'slicing',
  mesh_repair: 'slicing',
  energy_estimate: 'slicing',
  material_recommend: 'slicing',
  calibrate: 'slicing',
  'settings.plan': 'slicing',
  'settings.apply': 'slicing',
  // printers, fleets and spools (and every printer. and printer_ tool, below)
  fleet_overview: 'printers',
  schedule: 'printers',
  resume_from_layer: 'printers',
  overnight_readiness: 'printers',
  diagnose: 'printers',
  spool_fit: 'printers',
  spool_inventory: 'printers',
  ams_mapping: 'printers',
  toolhead_mapping: 'printers',
  // looking at and changing a running print through its camera
  check_print: 'watch',
  'print.adjust': 'watch',
  // painting color, seams, supports and fuzzy skin onto a part
  multicolor_assign: 'paint',
  web_search: 'web',
}

/** Name prefixes of whole tool families. */
const GROUP_PREFIX: readonly [string, ToolGroup][] = [
  ['printer.', 'printers'],
  ['printer_', 'printers'],
  ['spoolman.', 'printers'],
  ['design.', 'design'],
  ['geom.', 'design'],
  ['paint.', 'paint'],
  ['paint_', 'paint'],
  ['web.', 'web'],
]

/** The group a tool is switched with, by its name. */
export function toolGroupOf(toolName: string): ToolGroup {
  if (Object.hasOwn(GROUP_OF, toolName)) return GROUP_OF[toolName]!
  return GROUP_PREFIX.find(([p]) => toolName.startsWith(p))?.[1] ?? 'core'
}

/** `tools` without the groups the edition switched off, in order. Switches never add a tool, and core stays. */
export function applyToolGroups<T extends { name: string }>(tools: readonly T[], groups: ToolGroups | undefined): T[] {
  const off = new Set(TOOL_GROUPS.filter((g) => groups?.[g] === false))
  if (off.size === 0) return [...tools]
  return tools.filter((t) => {
    const g = toolGroupOf(t.name)
    return g === 'core' || !off.has(g)
  })
}
