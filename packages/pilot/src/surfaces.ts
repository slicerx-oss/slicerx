// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which tools mimir offers a model, by where it runs. A cloud model gets every tool the runtime has. A local model has
// a small context (see context.ts) where the tool schemas are most of the request, so it gets only the tools its
// surface uses: the mimir tab keeps its chat tools and its way into a design (the design tools, or text_to_part where a
// host has no design tools), without make_model. Of those, each turn sends only the ones on the surface's every-turn
// list and the ones the turn calls for (localTurnTools in toolsets.ts), and with the design tools only one set of
// them (turnsets.ts).
// An edition can also switch whole tool groups off (ai.brain.tools); a switch only ever takes tools away.
import type { PilotConfig } from '@slicerx/contracts'
import type { PilotTool } from './tool'

/** Where a mimir runs: the mimir tab. */
export type ToolSurface = 'tab'

/** Whether a config runs a local model (Ollama or LM Studio through their OpenAI-compatible server). */
export function isLocalModel(config: Pick<PilotConfig, 'provider'>): boolean {
  return config.provider === 'openai-compatible'
}

/** Tools a local model does not get, per surface. Everything else the surface has stays. */
const LOCAL_LEAVE_OUT: Record<ToolSurface, ReadonlySet<string>> = {
  // make_model's schema alone is about 1,700 tokens
  tab: new Set(['make_model']),
}

/**
 * The tools a local model gets on every turn, per surface: the questions, lookups and notes, the knowledge base, and
 * preparing and slicing the plate. This is an explicit list on purpose, so a tool registered later never grows every
 * turn of a local model's prompt: it joins a turn only when the turn calls for its toolset (toolsets.ts), until it is
 * named here. Status and device reads, G-code utilities, printer setup and the other rarely used tools stay off it.
 */
const LOCAL_EVERY_TURN: Record<ToolSurface, ReadonlySet<string>> = {
  tab: new Set([
    // asking, loading another set of tools (turnsets.ts), showing a looked up part, the dimension sheet and the
    // person's notes
    'pilot.ask',
    'pilot.tools',
    'pilot.report',
    'pilot.sheet',
    'pilot.sheet_bind',
    'lookup.show',
    'memory.recall',
    'memory.remember',
    // the project, the knowledge base and lookups
    'project.info',
    'parts.lookup',
    'web.lookup',
    'kb.search',
    'kb.filament',
    'kb.printer',
    'kb.troubleshoot',
    'kb.workflow',
    'kb.intent',
    'kb.sources',
    // a part from a description, where the host has no design tools
    'text_to_part',
    // preparing and slicing the plate
    'orient',
    'arrange',
    'slice',
    'estimate',
    'settings.get',
    'settings.plan',
    'settings.apply',
  ]),
}

/** Whether a local model on `surface` gets `name` on every turn. */
export function onEveryLocalTurn(surface: ToolSurface, name: string): boolean {
  return LOCAL_EVERY_TURN[surface].has(name)
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
  'settings.get': 'slicing',
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
  // the printer and spools a chat prints with
  'run.target': 'printers',
  // looking at and changing a running print through its camera
  check_print: 'watch',
  'print.adjust': 'watch',
  // painting color, seams, supports and fuzzy skin onto a part
  multicolor_assign: 'paint',
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

/**
 * Connected apps (packages/app/src/connected-apps/registry.ts) that work on the printers: sending prints (BamBuddy),
 * the spools in their slots (Spoolman) and the plugs and fans around them (Home Assistant). Their tools switch with
 * printers.
 */
export const PRINTER_APPS: ReadonlySet<string> = new Set(['bambuddy', 'spoolman', 'home-assistant'])

/** What a tool's group is read from: its name, and where a plugin or app command tool came from. */
export type GroupedTool = Pick<PilotTool, 'name'> & Partial<Pick<PilotTool, 'source' | 'permission' | 'plugin' | 'command' | 'printerFor' | 'approval'>>

/**
 * An app command's group: printer commands with printers, design workspace changes with design, and every other
 * command that changes something with slicing (plate edits such as cut and orient, slicing, profiles and settings).
 * A command that changes nothing, or only shares, has no switch.
 */
function commandGroup(c: NonNullable<PilotTool['command']>, permission: PilotTool['permission'] | undefined): ToolGroup {
  if (c.section === 'printers' || permission === 'start' || permission === 'queue' || permission === 'printer_config') return 'printers'
  // a command that changes nothing (go to a tab, step a layer) stays whatever is switched off
  if (!permission || permission === 'read' || permission === 'share') return 'core'
  if (c.workspace === 'design') return 'design'
  return 'slicing'
}

/**
 * The group a tool is switched with. A plugin's tool goes by its manifest: a printer connector or a connected app
 * that works on the printers is printers, and so is any other plugin tool that can reach a printer or ask for an
 * approval. An app command goes by its permission and section. Every other tool goes by its name.
 */
export function toolGroupOf(tool: GroupedTool): ToolGroup {
  if (tool.plugin && (tool.plugin.kind === 'printer' || PRINTER_APPS.has(tool.plugin.id))) return 'printers'
  if (tool.source === 'plugin' && (tool.printerFor || tool.approval)) return 'printers'
  if (tool.command) return commandGroup(tool.command, tool.permission)
  if (Object.hasOwn(GROUP_OF, tool.name)) return GROUP_OF[tool.name]!
  return GROUP_PREFIX.find(([p]) => tool.name.startsWith(p))?.[1] ?? 'core'
}

/** `tools` without the groups the edition switched off, in order. Switches never add a tool, and core stays. */
export function applyToolGroups<T extends GroupedTool>(tools: readonly T[], groups: ToolGroups | undefined): T[] {
  const off = new Set(TOOL_GROUPS.filter((g) => groups?.[g] === false))
  if (off.size === 0) return [...tools]
  return tools.filter((t) => {
    const g = toolGroupOf(t)
    return g === 'core' || !off.has(g)
  })
}
