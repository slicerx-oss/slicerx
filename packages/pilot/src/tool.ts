// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type {
  ApprovalToken,
  Citation,
  JobFile,
  PermissionClass,
  PilotChoice,
  PilotContext,
  PilotLookup,
  PilotSheet,
  PilotSheetAnswer,
  PrinterHost,
  SettingsDiff,
  SettingValue,
  SideEffectAction,
  SlicerHost,
  StartOptions,
  ToolDisplay,
  ToolSource,
  ToolSpec,
} from '@slicerx/contracts'
import { z } from 'zod'
import type { GeomHost, HistoryHost, ModelSearchHost, ProfilesHost, ProjectExportHost, SetupHost, ShareHost } from './hosts'
import type { KnowledgeBase } from './kb/kb'
import type { PilotProject } from './project'
import type { LlmImage } from './provider/types'

/** The parts of `Host` tools may use. Kept narrow so tests and evals can fake them. */
export interface ToolHost {
  printers: PrinterHost
  slicer?: SlicerHost
  /** Saved profiles. Writes verify the token for `profile.write` with `{ profileId, changes }`. */
  profiles?: ProfilesHost
  geom?: GeomHost
  history?: HistoryHost
  models?: ModelSearchHost
  share?: ShareHost
  setup?: SetupHost
  projectExport?: ProjectExportHost
}

export interface WebLookup {
  (query: string, signal?: AbortSignal): Promise<{ text: string; citations: Citation[] }>
}

export interface ToolContext {
  host: ToolHost
  sessionId: string
  callId: string
  signal: AbortSignal
  /** Present only after the user (or a policy the user set) approved this exact call. */
  token?: ApprovalToken
  context: PilotContext
  /** ISO date (YYYY-MM-DD) of the run, from the runtime clock. */
  today: string
  project?: PilotProject
  kb: KnowledgeBase
  web?: WebLookup
  progress(line: string, fraction?: number): void
  /** Asks the person a question with fixed answers and waits for the pick; absent where nobody can answer. */
  ask?(question: { title: string; question: string; choices: PilotChoice[] }): Promise<string>
  /** Shows a dimension sheet and waits for the person to confirm or edit it; absent where nobody can answer. */
  sheet?(sheet: Omit<PilotSheet, 'id'>): Promise<PilotSheetAnswer>
}

export interface ToolOutput {
  ok?: boolean
  /** One line shown on the folded tool row. */
  summary: string
  /** What the model sees (JSON). Keep it compact. */
  output?: unknown
  display?: ToolDisplay[]
  /** Images the model sees with the result, such as a camera frame. Kept out of `output`. */
  images?: LlmImage[]
  /** Set when the output carries text from files, printers or the network. */
  untrusted?: boolean
  citations?: Citation[]
  diff?: SettingsDiff
  report?: { title: string; rows: [string, string][] }
  /** For a host that shows text (MCP): this exact text instead of one made from summary and output. */
  text?: string
  /** For a host with structured replies (MCP): this exact object instead of `{ ok, summary, output }`. */
  structured?: Record<string, unknown>
  /** A reply the host returns as it is: a call that resolves another call's approval answers with that call's reply. */
  passthrough?: unknown
  /** A record to show the person as a card, with its source. */
  lookup?: Omit<PilotLookup, 'id'>
}

/** The sets tools load in (docs: agent tools architecture). A client starts with core and loads the others it needs. */
export type Toolset = 'core' | 'cad' | 'mesh' | 'settings' | 'project' | 'printers' | 'fleets' | 'kb' | 'calibration' | 'cloud' | 'theme' | 'local_ai' | 'skills'

export interface PlannedAction {
  action: SideEffectAction
  target: string
  /** The exact parameters the host call will see; hashed into the approval. */
  params: unknown
}

export interface ApprovalPlan {
  title: string
  lines: string[]
  printerId?: string
  actions: PlannedAction[]
}

/**
 * Work only a person may approve (start a print, resume, send G-code), described so the
 * hub can run it itself once a person approves the card in SlicerX or on the phone. The
 * agent that asked never holds the token. Matches sx-link's `approvals.register` `work`.
 */
export type AgentWork =
  | { kind: 'print'; printerId: string; file: JobFile; opts?: StartOptions }
  | { kind: 'resume'; printerId: string }
  | { kind: 'gcode'; printerId: string; line: string }
  /** A connected app's tool a person has to approve, such as switching a Home Assistant device. */
  | { kind: 'plugin'; pluginId: 'spoolman' | 'home-assistant'; tool: string; input: Record<string, unknown> }

export interface PilotTool<I = unknown> {
  name: string
  version: string
  description: string
  source: ToolSource
  permission: PermissionClass
  input: z.ZodType<I>
  /** A short name for people, such as "Slice a model file". */
  title?: string
  /** Other words makers use for it (bevel for chamfer), for finding it. */
  aliases?: string[]
  /** The set it loads with. */
  toolset?: Toolset
  /** The shape of `structured` replies, published as the MCP output schema. */
  outputShape?: z.ZodRawShape
  /** MCP hints when the permission class does not say it, such as a read tool that writes files to the output folder. */
  hints?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean }
  /**
   * Runs without the permission gate and the action log: lookups that change nothing outside the output folder,
   * and calls about the server itself (approvals, the policy, the log). A tool marked so must be read class.
   */
  ungated?: boolean
  /** When the class depends on the input, such as settings.apply to a saved profile. */
  permissionFor?(input: I): PermissionClass
  /** Printer the call targets, for per-printer policy overrides. */
  printerFor?(input: I): string | undefined
  /**
   * Reasons this particular call needs the user even when its class is set to
   * Allow, such as a guarded setting outside the filament's range. Empty: none.
   */
  mustAsk?(input: I, ctx: ToolContext): Promise<string[]>
  /** Required for every class except read: what the approval card shows and which host calls it unlocks. */
  approval?(input: I, ctx: ToolContext): Promise<ApprovalPlan>
  /**
   * For tools whose approval only a person may give: the work for the hub to run, with
   * exactly the host calls the approval plan lists.
   */
  agentWork?(input: I, ctx: ToolContext): Promise<AgentWork>
  /** Display form of the arguments, shown as the row's command line. */
  args?(input: I): string
  run(input: I, ctx: ToolContext): Promise<ToolOutput>
}

export function defineTool<I>(tool: PilotTool<I>): PilotTool<I> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(tool.name)) throw new Error(`Bad tool name ${tool.name}`)
  if (tool.ungated && tool.permission !== 'read') throw new Error(`${tool.name}: only a read tool can run without the gate`)
  return tool
}

/** Skills are tools with source `skill`, listed in the inspector. */
export function defineSkill<I>(tool: Omit<PilotTool<I>, 'source'> & { summary?: string }): PilotTool<I> {
  return defineTool({ ...tool, source: 'skill' })
}

export function toolSpec(t: PilotTool<never> | PilotTool<unknown>): ToolSpec {
  const schema = z.toJSONSchema(t.input as z.ZodType, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>
  const { $schema: _s, ...rest } = schema
  const inputSchema = { type: 'object' as const, properties: {}, ...rest } as ToolSpec['inputSchema']
  return {
    name: t.name,
    version: t.version,
    description: t.description,
    inputSchema,
    permission: t.permission,
    source: t.source,
  }
}

/** Default display form of arguments: `--key value` pairs, quoted when they contain spaces. */
export function argLine(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  return Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => {
      const flag = `--${k.replaceAll('_', '-')}`
      if (v === true) return flag
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return `${flag} ${/\s/.test(s) ? `"${s}"` : s}`
    })
    .join(' ')
}
