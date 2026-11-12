// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type {
  ApprovalToken,
  Citation,
  CommandSpec,
  JobFile,
  PermissionClass,
  PilotChoice,
  PilotContext,
  PilotLookup,
  PilotSheet,
  PilotSheetAnswer,
  PilotSheetBind,
  PluginKind,
  PrinterHost,
  SettingsDiff,
  SettingValue,
  SideEffectAction,
  SlicerHost,
  SlotSetting,
  StartOptions,
  ToolDisplay,
  ToolSource,
  ToolSpec,
} from '@slicerx/contracts'
import { z } from 'zod'
import type { GeomHost, HistoryHost, ModelSearchHost, ProfilesHost, ProjectExportHost, SetupHost, ShareHost } from './hosts'
import type { KnowledgeBase } from './kb/kb'
import { keepDescriptions } from './local-schema'
import { LOCAL_TOOLS } from './local-tools'
import type { PilotProject } from './project'
import type { RunHandle } from './run/print-run'
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
  /**
   * Whether this device reaches the printers' network directly. False through a relay (a phone away from home): a
   * printer's own web page is then not offered, since its local address would open on whatever network the device
   * is on. Absent means it does.
   */
  localNetwork?: () => Promise<boolean>
}

export interface WebLookup {
  (query: string, signal?: AbortSignal): Promise<{ text: string; citations: Citation[] }>
}

/** The choice id of a question the person dismissed. Choice ids are never empty, so it cannot be a real pick. */
export const ASK_DISMISSED = ''

/** The most a person's words in place of a pick may be, in characters; longer is cut. */
export const ASK_SAID_MAX = 1000

/** True when a question's answer is a dismiss, not a pick. */
export function wasDismissed(id: string): boolean {
  return id === ASK_DISMISSED
}

/** The answer to a question: the picked choice id (`ASK_DISMISSED` for a dismiss), and what the person wrote instead. */
export interface AskAnswer {
  id: string
  said?: string
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
  /** The runtime clock, in ms since the epoch; absent outside the runtime (an MCP gate). */
  now?: () => number
  project?: PilotProject
  kb: KnowledgeBase
  web?: WebLookup
  progress(line: string, fraction?: number): void
  /**
   * Asks the person a question with fixed answers and waits for the answer: the picked choice id, or `ASK_DISMISSED`
   * when they turned the question down, with what they wrote instead in `said`. Absent where nobody can answer.
   */
  ask?(question: { title: string; question: string; choices: PilotChoice[] }, opts?: { auto?: string }): Promise<AskAnswer>
  /**
   * Whether this run's sizes must fit something (a sheet with fits), or its plan prints pieces assembled that move: a
   * plan card then waits for the person's Go. Otherwise a plan at its default size is approved as shown (ask with auto).
   */
  confirmsPlan?(): boolean
  /**
   * Shows a dimension sheet and waits for the person to confirm or edit it; absent where nobody can answer. A sheet
   * without fits shows and is confirmed as shown at once.
   */
  sheet?(sheet: Omit<PilotSheet, 'id'>): Promise<PilotSheetAnswer>
  /** True when a built design with this id is there for a sheet to draw; absent where the host has no plate. */
  sheetDesign?(id: string): boolean
  /** Ties the last sheet's rows to the steps they set; false when this run showed no sheet. */
  bindSheet?(design: string, binds: PilotSheetBind[]): boolean
  /** The chat's print run; present only when the host keeps print runs. */
  run?: RunHandle
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
  /**
   * Set on a refusal of the call's own input, before the tool did anything (a sheet row with no place on the drawing):
   * the model's slip, fixed by sending the call again, so Auto does not take it for struggling (runtime.ts).
   */
  inputRefused?: boolean
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
  /** Skip one object of the running print; `epoch` is the running print's bed epoch from the hub, and is hashed. */
  | { kind: 'skip'; printerId: string; id: string; epoch: number }
  /** Home every axis under the hub's home rules (printer state and plate), checked when the person approves. */
  | { kind: 'home'; printerId: string }
  /** Set one filament slot while no print runs, hashed as `printer.adjust` `{printerId, slot: setting}`. Approved in the app only. */
  | { kind: 'slot'; printerId: string; setting: SlotSetting }
  /** A filament change (M600): mid-print as it is, on an idle or finished printer under the plate rule. */
  | { kind: 'filament_change'; printerId: string }
  /** A connected app's tool a person has to approve, such as switching a Home Assistant device. */
  | { kind: 'plugin'; pluginId: 'spoolman' | 'home-assistant'; tool: string; input: Record<string, unknown> }

export interface PilotTool<I = unknown> {
  name: string
  version: string
  description: string
  /**
   * The description a local model gets, whose whole context is MIMIR_CONTEXT tokens (context.ts): what the tool does,
   * its required arguments and every rule `description` states, in fewer words. A rule needed only now and then may
   * instead live in a knowledge base entry the description names (`More: kb.search "hole tool".`). Unset sends
   * `description`. A cloud model, MCP clients and the read-backs always get `description`.
   */
  localDescription?: string
  /**
   * The input a local model is shown, when it leaves out fields that only a cloud model or MCP client is told to use
   * (a field costs a local model's context on every turn). The tool takes and checks `input` either way.
   */
  localInput?: z.ZodType
  source: ToolSource
  permission: PermissionClass
  input: z.ZodType<I>
  /** A short name for people, such as "Slice a model file". */
  title?: string
  /** Other words makers use for it (bevel for chamfer), for finding it. */
  aliases?: string[]
  /** For a plugin's tool: the manifest it came from, which decides its tool group (surfaces.ts). */
  plugin?: { id: string; kind: PluginKind }
  /** For an app command's tool: where the command sits, which decides its tool group (surfaces.ts). */
  command?: { id: string; section: CommandSpec['section']; workspace?: string }
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
  /**
   * When the person turned asking off for this tool alone (Save notes without asking, for memory.remember): the line
   * the chat shows instead of the card, and the call runs as Allow would. Null asks as its class says; Off still stops it.
   */
  withoutAsking?(input: I): string | null
  /** Required for every class except read: what the approval card shows and which host calls it unlocks. */
  approval?(input: I, ctx: ToolContext): Promise<ApprovalPlan>
  /**
   * For tools whose approval only a person may give: the work for the hub to run, with
   * exactly the host calls the approval plan lists.
   */
  agentWork?(input: I, ctx: ToolContext): Promise<AgentWork>
  /** Display form of the arguments, shown as the row's command line. */
  args?(input: I): string
  /** The input as the tool_call event and session log carry it, when the raw input may hold something never to show (a refused secret). */
  shownInput?(input: I): unknown
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

/** Keywords whose value is one schema. */
const ONE_SCHEMA = new Set(['items', 'additionalProperties', 'propertyNames', 'not', 'contains', 'if', 'then', 'else', 'unevaluatedItems', 'unevaluatedProperties'])
/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAP = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * `out` (the schema toolSpec publishes) without the keywords that tell a model nothing about what the tool takes, read
 * against `inp`, the same schema as zod writes it for the tool's input. Dropped: the safe integer range zod gives an
 * integer with no bounds of its own; `additionalProperties: {}` (any value, as with no keyword); `propertyNames` of
 * plain strings (every JSON key is one); `minLength: 1` (a string that is not empty, which no model sends on purpose,
 * and the tool still refuses one); and `additionalProperties: false` on an object whose input form leaves it
 * open, since the tool strips unknown keys there rather than refusing them. A strict object keeps it. The type beside a
 * const goes too, since the const is the one value taken, and so does the string type beside an enum of strings, since
 * the enum lists every value taken. A tuple of one kind is written as the plain array it equals (sameTuple). Everything
 * else, every other type, bound, enum, default, required list and description, stays as it is.
 */
function leanSchema(out: unknown, inp: unknown): unknown {
  if (!isRecord(out)) return out
  const i = isRecord(inp) ? inp : undefined
  const lean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(out)) {
    if ((k === 'maximum' && v === Number.MAX_SAFE_INTEGER) || (k === 'minimum' && v === Number.MIN_SAFE_INTEGER)) continue
    if (k === 'additionalProperties' && isRecord(v) && Object.keys(v).length === 0) continue
    if (k === 'propertyNames' && isRecord(v) && Object.keys(v).length === 1 && v.type === 'string') continue
    if (k === 'minLength' && v === 1) continue
    if (k === 'additionalProperties' && v === false && i?.type === 'object' && !('additionalProperties' in i)) continue
    if (k === 'type' && 'const' in out) continue
    if (k === 'type' && v === 'string' && Array.isArray(out.enum) && out.enum.length > 0 && out.enum.every((e) => typeof e === 'string')) continue
    const iv = i?.[k]
    if (ONE_SCHEMA.has(k)) lean[k] = leanSchema(v, iv)
    else if (SCHEMA_LIST.has(k) && Array.isArray(v)) lean[k] = v.map((s, n) => leanSchema(s, Array.isArray(iv) ? iv[n] : undefined))
    else if (SCHEMA_MAP.has(k) && isRecord(v)) lean[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, leanSchema(s, isRecord(iv) ? iv[p] : undefined)]))
    else lean[k] = v
  }
  return sameTuple(lean)
}

/**
 * A tuple whose places all take the same schema (a point [u, v] or [x, y, z]) as the plain array it equals: `items`
 * that schema with the same minItems and maxItems, instead of a copy of it per place and `items: false`. A point costs
 * a local model about a third fewer tokens this way, and takes exactly the same values.
 */
function sameTuple(s: Record<string, unknown>): Record<string, unknown> {
  const places = s.prefixItems
  if (!Array.isArray(places) || places.length === 0 || s.items !== false || s.minItems !== places.length || s.maxItems !== places.length) return s
  const one = JSON.stringify(places[0])
  if (!places.every((p) => JSON.stringify(p) === one)) return s
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (k === 'prefixItems') out.items = places[0]
    else if (k !== 'items') out[k] = v
  }
  return out
}

/**
 * The tool as a local model gets it (runtime.ts): its localDescription when it has one, else its description only when
 * its row in LOCAL_TOOLS (local-tools.ts) says so, and its input schema (its localInput when it has one) without the
 * keywords that say nothing (leanSchema) and with only the field descriptions its row lists. Text that is not listed
 * reaches cloud turns only. The tool takes and checks exactly the same input either way; a cloud model and MCP clients
 * get toolSpec.
 */
export function localToolDef(t: PilotTool<never> | PilotTool<unknown>): { name: string; description: string; parameters: ToolSpec['inputSchema'] } {
  const shown = t.localInput ? { ...t, input: t.localInput } : t
  const spec = toolSpec(shown as PilotTool<unknown>)
  let input: unknown
  try {
    input = z.toJSONSchema(shown.input as z.ZodType, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' })
  } catch {
    // no input form: every object keeps additionalProperties as published
    input = undefined
  }
  const row = LOCAL_TOOLS[t.name]
  const description = t.localDescription ?? (row?.description ? t.description : '')
  return { name: t.name, description, parameters: keepDescriptions(leanSchema(spec.inputSchema, input), new Set(row?.fields ?? [])) as ToolSpec['inputSchema'] }
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
