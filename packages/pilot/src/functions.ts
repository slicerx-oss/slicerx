// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/pilot/functions: the deterministic checks and project operations as
// plain functions. The app calls them directly and shows the result as UI: no
// model, no key, no chat. mimir is not offered these tools.
import type { Citation, PilotContext, ToolDisplay, ToolSpec } from '@slicerx/contracts'
import { createAppFunctionTools } from '../skills/index'
import { createKnowledgeBase, type KbIndex, type KnowledgeBase } from './kb/kb'
import type { PilotProject } from './project'
import { createShared, type ToolShared } from './shared'
import { toolSpec, type PilotTool, type ToolContext, type ToolHost } from './tool'

/** What a function may read. Only `host` is required. */
export interface FunctionEnv {
  host: ToolHost
  /** The open project, for checks on objects and plates. */
  project?: PilotProject
  /** Printer, material and objects in view, as mimir would see them. */
  context?: PilotContext
  /** Sliced plates (G-code and results by plate number), for gcode, spool and overnight checks. */
  shared?: ToolShared
  /** The knowledge base. Default: the bundled one. */
  kb?: KnowledgeBase
  /** ISO date (YYYY-MM-DD). Default: today. */
  today?: string
  signal?: AbortSignal
  onProgress?(line: string, fraction?: number): void
}

export interface FunctionResult {
  ok: boolean
  /** One line for a chip or a toast. */
  summary: string
  /** Structured result, as the tool returns it. */
  output?: unknown
  /** Tables, warnings and diffs ready to render with DisplayView. */
  display?: ToolDisplay[]
  citations?: Citation[]
}

/** Every function name, in the order the app usually runs them. */
export const APP_FUNCTIONS = [
  'gcode_inspect',
  'printer_config_check',
  'spool_fit',
  'overnight_readiness',
  'risk_report',
  'spool_inventory',
  'energy_estimate',
  'printer_match',
  'fleet_overview',
  'supports',
  'orientation_search',
  'fit_check',
  'mesh_analyze',
  'mesh_repair',
  'hollow',
  'emboss',
  'scale_with_tolerance',
  'threads_and_fits',
  'smart_layer',
  'multicolor_assign',
  'ams_mapping',
  'region_modifiers',
] as const
export type AppFunctionName = (typeof APP_FUNCTIONS)[number]

/** Classes a function may have: reading, or changing the open project the user is looking at. */
const ALLOWED = new Set(['read', 'slice'])

let bundledKb: Promise<KnowledgeBase> | null = null
function defaultKb(): Promise<KnowledgeBase> {
  bundledKb ??= import('./kb/generated/kb.json', { with: { type: 'json' } }).then((m) => createKnowledgeBase(m.default as unknown as KbIndex))
  return bundledKb
}

function tools(shared: ToolShared): Map<string, PilotTool<never>> {
  return new Map(createAppFunctionTools(shared).map((t) => [t.name, t]))
}

/** Name, description, input schema and permission of every function, for forms and docs. */
export function appFunctionSpecs(): ToolSpec[] {
  return [...tools(createShared()).values()].map((t) => toolSpec(t))
}

/**
 * Runs one function. Input is validated with the same schema mimir's
 * tools use; an unknown name, a bad input or a failing host becomes
 * `ok: false` with the reason in `summary`.
 */
export async function runAppFunction(name: string, input: unknown, env: FunctionEnv): Promise<FunctionResult> {
  const shared = env.shared ?? createShared()
  const tool = tools(shared).get(name)
  if (!tool) return { ok: false, summary: `Unknown function ${name}` }
  if (!ALLOWED.has(tool.permission)) return { ok: false, summary: `${name} needs an approval and cannot run as a plain function` }
  const parsed = (tool.input as unknown as { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } } }).safeParse(input ?? {})
  if (!parsed.success) {
    const issue = parsed.error?.issues[0]
    return { ok: false, summary: `Bad input for ${name}${issue ? `: ${issue.path.join('.') || 'input'} ${issue.message}` : ''}` }
  }
  const ctx: ToolContext = {
    host: env.host,
    sessionId: 'app',
    callId: `${name}-${Date.now().toString(36)}`,
    signal: env.signal ?? new AbortController().signal,
    context: env.context ?? {},
    today: env.today ?? new Date().toISOString().slice(0, 10),
    kb: env.kb ?? (await defaultKb()),
    progress: (line, fraction) => env.onProgress?.(line, fraction),
    ...(env.project ? { project: env.project } : {}),
  }
  try {
    const out = await tool.run(parsed.data as never, ctx)
    return {
      ok: out.ok !== false,
      summary: out.summary,
      ...(out.output !== undefined ? { output: out.output } : {}),
      ...(out.display ? { display: out.display } : {}),
      ...(out.citations ? { citations: out.citations } : {}),
    }
  } catch (e) {
    return { ok: false, summary: e instanceof Error ? e.message : String(e) }
  }
}

export interface PreflightInput {
  printerId: string
  /** Sliced plate to check. */
  plate?: number
  /** G-code text, when the job is a file rather than a sliced plate. */
  gcode?: string
  material?: string
  /** Max volumetric speed of the filament profile the job was sliced with, mm3/s. */
  maxFlowMm3s?: number
}

export interface PreflightResult {
  /** Fails when any check failed; warnings alone pass. */
  ok: boolean
  checks: { name: 'gcode_inspect' | 'printer_config_check' | 'spool_fit'; result: FunctionResult }[]
}

/**
 * The send preflight: G-code lint, the printer's own config, and whether the
 * loaded spool lasts. Runs the three checks together; each result is shown on
 * its own.
 */
export async function preflight(input: PreflightInput, env: FunctionEnv): Promise<PreflightResult> {
  const material = input.material !== undefined ? { material: input.material } : {}
  const plate = input.plate !== undefined ? { plate: input.plate } : {}
  const gcode = input.gcode !== undefined ? { text: input.gcode } : plate
  const [g, c, s] = await Promise.all([
    runAppFunction('gcode_inspect', { ...gcode, ...material, ...(input.maxFlowMm3s !== undefined ? { maxFlowMm3s: input.maxFlowMm3s } : {}) }, env),
    runAppFunction('printer_config_check', { printerId: input.printerId }, env),
    runAppFunction('spool_fit', { printerId: input.printerId, ...plate, ...material }, env),
  ])
  const checks: PreflightResult['checks'] = [
    { name: 'gcode_inspect', result: g },
    { name: 'printer_config_check', result: c },
    { name: 'spool_fit', result: s },
  ]
  return { ok: checks.every((x) => x.result.ok), checks }
}
