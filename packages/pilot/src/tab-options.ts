// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the mimir tab's runtime is made from, apart from the host: the step and tool call limits a part needs, the
// scope (the browser build only models), the commands mimir may run there, the edition's brain pack (its tool groups,
// web search, routing), the knowledge and planner, and the tools. The app's tab (session.ts tabPilotOptions) and the
// creative eval (evals/creative/run.ts) both build their runtime from tabOptions, so the eval runs what the tab runs.
import { DEFAULT_POLICY, type CommandSpec, type PilotConfig } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { createCombinedPlanner } from './kb/combined-planner'
import type { KnowledgeBase } from './kb/kb'
import type { CreatePilotOptions } from './runtime'
import { TOOL_GROUPS, type ToolGroups } from './surfaces'
import type { PilotTool } from './tool'

/** The fewest steps a tab run gets: a part takes many feature steps. */
export const TAB_MIN_STEPS = 40
/** The fewest tool calls a tab run gets. */
export const TAB_MIN_TOOL_CALLS = 60

/** `config` with at least the tab's step and tool call limits; a higher limit stays. */
export function tabLimits(config: PilotConfig): PilotConfig {
  return { ...config, maxSteps: Math.max(config.maxSteps, TAB_MIN_STEPS), maxToolCalls: Math.max(config.maxToolCalls, TAB_MIN_TOOL_CALLS) }
}

/** The tab's scope: the whole toolset where the host slices, the cad scope (design, knowledge, project) where it does not. */
export function tabScope(slices: boolean): 'cad' | undefined {
  return slices ? undefined : 'cad'
}

/** Commands that slice, print or change slicer settings, which a host that only models leaves out of mimir's tools. */
export function modelingCommands(commands: readonly CommandSpec[]): CommandSpec[] {
  return commands.filter((c) => c.section !== 'slice' && c.section !== 'printers' && c.section !== 'settings' && c.id !== 'mode-slice' && !c.id.startsWith('layer-'))
}

/** The groups the edition switched off (false), as the runtime applies them with applyToolGroups. */
export function editionToolGroups(edition: Pick<EditionConfig, 'ai'>): ToolGroups {
  const tools = edition.ai.brain.tools ?? {}
  return Object.fromEntries(TOOL_GROUPS.filter((g) => tools[g] === false).map((g) => [g, false])) as ToolGroups
}

/**
 * `config` with the edition's brain pack on it: no web search when the web group is off, and ai.brain.routing as the
 * models for the person's own key (mimir cloud ignores it; its proxy picks the model).
 */
export function withBrain(config: PilotConfig, edition: Pick<EditionConfig, 'ai'>): PilotConfig {
  const brain = edition.ai.brain
  const out: PilotConfig = { ...config }
  if (brain.tools?.web === false) out.webSearch = false
  const r = brain.routing
  if (r && (r.base !== undefined || r.step !== undefined)) {
    out.routing = { ...(r.provider !== undefined ? { provider: r.provider } : {}), ...(r.base !== undefined ? { base: r.base } : {}), ...(r.step !== undefined ? { step: r.step } : {}) }
  }
  return out
}

export interface TabParts {
  /** Whether the host slices (the desktop app); the browser build only models. */
  slices: boolean
  config: PilotConfig
  kb: KnowledgeBase
  tools: readonly PilotTool<never>[]
  /** The host's commands as mimir runs them; a host that does not slice keeps only the modeling ones. */
  commands: readonly CommandSpec[]
  client?: CreatePilotOptions['client']
  share?: CreatePilotOptions['share']
  memory?: CreatePilotOptions['memory']
  toolGroups?: CreatePilotOptions['toolGroups']
}

export type TabOptions = Pick<CreatePilotOptions, 'config' | 'scope' | 'surface' | 'policy' | 'commands' | 'kb' | 'planner' | 'tools' | 'client' | 'share' | 'memory' | 'toolGroups'>

/** The tab's runtime options apart from the host, its project, tabs, store, log and print run. */
export function tabOptions(parts: TabParts): TabOptions {
  const scope = tabScope(parts.slices)
  return {
    config: tabLimits(parts.config),
    ...(scope ? { scope } : {}),
    surface: 'tab',
    policy: DEFAULT_POLICY,
    commands: parts.slices ? [...parts.commands] : modelingCommands(parts.commands),
    kb: parts.kb,
    planner: createCombinedPlanner(parts.kb),
    tools: [...parts.tools],
    ...(parts.client ? { client: parts.client } : {}),
    ...(parts.share ? { share: parts.share } : {}),
    ...(parts.memory ? { memory: parts.memory } : {}),
    ...(parts.toolGroups ? { toolGroups: parts.toolGroups } : {}),
  }
}
