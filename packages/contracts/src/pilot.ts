// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir runtime, tools, permissions and the LLM transport.

export const PERMISSION_CLASSES = ['read', 'slice', 'queue', 'start', 'profile', 'printer_config', 'share'] as const
export type PermissionClass = (typeof PERMISSION_CLASSES)[number]
export type PermissionMode = 'allow' | 'ask' | 'off'

/** Classes every policy spells out. The later ones default to ask when a policy omits them. */
export type CorePermissionClass = 'slice' | 'queue' | 'start' | 'profile'

export interface PermissionPolicy {
  classes: Record<CorePermissionClass, PermissionMode> & Partial<Record<'printer_config' | 'share', PermissionMode>>
  /** Per printer id. `start: 'allow'` is only valid here, never in `classes`. */
  printers?: Record<string, Partial<Record<'queue' | 'start', PermissionMode>>>
}

export const DEFAULT_POLICY: PermissionPolicy = {
  classes: { slice: 'allow', queue: 'ask', start: 'ask', profile: 'ask', printer_config: 'ask', share: 'ask' },
}

/** Labels used by the Permissions panel and the approval card. */
export const PERMISSION_LABELS: Record<Exclude<PermissionClass, 'read'>, { title: string; detail: string }> = {
  slice: { title: 'Slice and arrange', detail: 'Orient, cut, arrange and slice in your project' },
  queue: { title: 'Queue jobs', detail: 'Send sliced plates to a printer queue' },
  start: { title: 'Start or resume prints', detail: 'Heat up and move a printer' },
  profile: { title: 'Change saved profiles', detail: 'Write to printer and filament profiles' },
  printer_config: { title: 'Change printer settings', detail: 'Failure detection, firmware and printer config' },
  share: { title: 'Share and notify', detail: 'Send messages or publish outside the app' },
}

/** Tool families. The chat shows the family as the keyword on each tool row. */
export type ToolSource = 'skill' | 'plugin' | 'command' | 'kb' | 'settings' | 'web'

/** JSON Schema object for a tool's input. */
export type JsonSchema = { type: 'object'; properties: Record<string, unknown>; required?: string[]; [k: string]: unknown }

export interface ToolSpec {
  /** Dotted for plugins (`moonraker.status`), bare for skills (`slice`), `app.` for commands, `kb.` for knowledge. */
  name: string
  version: string
  description: string
  inputSchema: JsonSchema
  permission: PermissionClass
  source: ToolSource
}

// ---------------------------------------------------------------------------
// Approvals

/**
 * Host calls that change something outside the project. Each one verifies an
 * approval token for its exact action, target and parameter hash.
 */
export const SIDE_EFFECT_ACTIONS = [
  'printer.upload',
  'printer.start',
  'printer.pause',
  'printer.resume',
  'printer.cancel',
  'printer.gcode',
  'printer.adjust',
  'plugin.call',
  'profile.write',
  'project.replace',
  'printer.config',
  'share.notify',
  'share.publish',
] as const
export type SideEffectAction = (typeof SIDE_EFFECT_ACTIONS)[number]

/**
 * One host call an approval covers. `paramsHash` is `hashParams()` of the
 * parameters the host itself sees for that call:
 * - printer.upload: `{ printerId, name, sha256 }` of the JobFile
 * - printer.start: `{ printerId, name, opts, sha256 }` (RemoteFile name, StartOptions with `{}` when none,
 *   and the content hash the card shows; `sha256` is left out only for a file whose content is not known)
 * - printer.pause | resume | cancel: `{ printerId }`
 * - printer.gcode: `{ printerId, line }`
 * - printer.adjust: `{ printerId, change }`, the change to a running print as the hub checks it
 *   or `{ printerId, slot }`, a SlotSetting written to an AMS slot (app only)
 * - plugin.call: `{ pluginId, tool, input }`
 * - profile.write: `{ profileId, changes }`
 * - project.replace: `{ objectIds, with }`
 * - printer.config: `{ printerId, changes }`
 * - share.notify: `{ title, body, channel }`
 * - share.publish: `{ title, audience }` plus the sha256 of the report text as `sha256`
 */
export interface ApprovalAction {
  action: SideEffectAction
  /** Printer id, plugin id, profile id or project id. */
  target: string
  paramsHash: string
}

/** Where a request to start a print came from (sx-permit `StartOrigin`, wire names). The hub refuses a start from anywhere but `local_click` unless the grant says the bed is clear. */
export type ApprovalOrigin = 'local_click' | 'pilot' | 'mcp' | 'phone' | 'queue' | 'schedule' | 'inbox'

export interface ApprovalRequest {
  id: string
  sessionId: string
  tool: string
  permission: PermissionClass
  /** One line question shown on the approval card. */
  title: string
  lines: string[]
  printerId?: string
  /** Who raised the request. Absent on older hosts. */
  origin?: ApprovalOrigin
  /** SHA-256 of the canonical JSON of the tool input as the model sent it. */
  paramsHash: string
  /** Every host call the approval unlocks, each usable once. */
  actions: ApprovalAction[]
  expiresAt: string
}

/**
 * Minted by the host (sx-permit, or the TS broker for the browser demo) after
 * the user approves. Bound to the request's actions; each action can be
 * verified once, and the token dies at `expiresAt` (5 minutes).
 * Never shown to the model and never written to a session log.
 */
export interface ApprovalToken {
  requestId: string
  token: string
  expiresAt: string
}

/** `bedClear` is true only when the person answered "the build plate is clear" on the card that asked it. */
export type ApprovalDecision = { kind: 'approve'; bedClear?: boolean } | { kind: 'deny'; reason?: string }

export type ApprovalFailure = 'unknown' | 'expired' | 'used' | 'mismatch' | 'bad_signature' | 'denied'

export type ApprovalCheck = { ok: true } | { ok: false; reason: ApprovalFailure }

// ---------------------------------------------------------------------------
// Rendering helpers carried by events

/** Semantic tone for a value in tool output, mapped to the palette by the UI. */
export type Tone = 'ok' | 'warn' | 'bad' | 'run' | 'dim' | 'hl'
export type Cell = string | { text: string; tone: Tone }

/** Structured tool output the chat renders in a tool row's detail. */
export type ToolDisplay =
  | { kind: 'kv'; rows: [string, Cell][] }
  | { kind: 'table'; head: string[]; rows: Cell[][] }
  | { kind: 'log'; lines: { time?: string; text: string; tone?: Tone }[] }
  | { kind: 'progress'; items: { label: string; fraction: number; note?: string }[] }
  | { kind: 'text'; text: string }
  /** A picture shown in the transcript, such as a camera frame. `src` is a data: URL; `alt` describes it for screen readers. */
  | { kind: 'image'; src: string; alt: string; caption?: string }

export interface Citation {
  /** Knowledge source id (`prusa_kb_petg`), prefixed path (`orca:...`) or a web URL. */
  id: string
  title: string
  url?: string
  publisher?: string
  kind: 'kb' | 'web'
}

export interface SettingsDiffRow {
  /** Orca key. */
  key: string
  label?: string
  before: string | null
  after: string
  unit?: string
  reason?: string
  sources?: string[]
  /** Set when applying this row needs approval (a guarded key outside the filament's range). */
  approval?: 'ask'
}

export interface SettingsDiff {
  /** Header line, such as "Plate overrides for PETG. The saved profile is unchanged." */
  title: string
  /** Where the change lands. Only `profile` and `printer` need an approval to apply. */
  scope: 'plate' | 'project' | 'profile' | 'printer' | 'proposal'
  rows: SettingsDiffRow[]
  /** Set when the diff came from a context switch (material, printer or nozzle). */
  trigger?: { from: PilotMachine; to: PilotMachine }
}

export interface PluginLoad {
  id: string
  name: string
  detail?: string
  state: 'loading' | 'ready' | 'off' | 'error'
  tools: number
}

// ---------------------------------------------------------------------------
// Events

export type PilotEvent =
  | { type: 'start'; runId: string; sessionId: string; provider: string; model: string; at: string }
  | { type: 'plugins'; plugins: PluginLoad[] }
  | { type: 'thinking'; delta: string }
  | { type: 'thinking_done'; ms: number }
  | { type: 'text'; delta: string }
  | { type: 'text_done' }
  | { type: 'plan'; steps: string[] }
  | { type: 'tool_call'; callId: string; tool: string; source: ToolSource; input: unknown; args?: string; summary?: string }
  | { type: 'tool_progress'; callId: string; line: string; fraction?: number }
  | {
      type: 'tool_result'
      callId: string
      ok: boolean
      summary: string
      output?: unknown
      display?: ToolDisplay[]
      untrusted?: boolean
      ms?: number
    }
  | { type: 'settings_diff'; diff: SettingsDiff }
  | { type: 'citations'; items: Citation[] }
  | { type: 'permission_note'; permission: PermissionClass; mode: 'allow' | 'off'; tool: string; message: string }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_resolved'; requestId: string; decision: ApprovalDecision; by: 'user' | 'policy' | 'expiry'; via?: 'card' | 'phone' }
  | { type: 'summary'; title: string; rows: [string, string][]; stopped: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'done'; stopReason: 'end' | 'max_steps' | 'canceled' | 'denied' | 'error'; ms: number }

// ---------------------------------------------------------------------------
// Configuration and context

export interface PilotConfig {
  /** Provider adapter id: 'openai' first, later 'anthropic' and 'openai-compatible'. */
  provider: string
  /** Model id, always from config, never hardcoded. */
  model: string
  baseUrl?: string
  maxSteps: number
  maxToolCalls: number
  /** Reasoning effort hint for providers that support it. */
  reasoning?: 'low' | 'medium' | 'high'
  /** Allow the provider's hosted web search for `web.lookup`. */
  webSearch?: boolean
  /**
   * The assistant's two tiers: huginn for quick looks (check-ins, frame reads, short answers),
   * muninn for deep thinking (diagnosis, tune-from-failure, planning). Each falls back to `model`.
   */
  models?: { huginn?: string; muninn?: string }
  /** Settings > mimir > Model: `automatic` (the default) or one model id pinned for everything. */
  modelChoice?: string
  /** Who pays, set by the host: the user's ChatGPT `plan`, or an API `key` billed per token (then huginn does everything). */
  billing?: 'plan' | 'key'
}

/** The machine a plate targets. Ids are knowledge ids (`prusa_mk4s`, `petg`). */
export interface PilotMachine {
  printer: string
  material: string
  /** Nozzle diameter, mm. */
  nozzle: number
}

/** What Pilot can see about the open project when a run starts. */
export interface PilotContext {
  project?: string
  machine?: PilotMachine
  /** Fleet printer id the plate is assigned to, when there is one. */
  printerId?: string
  /** Current process values that differ from the profile, by Orca key. */
  overrides?: Record<string, string | number | boolean>
  objects?: { id: string; name: string; bboxMm?: [number, number, number] }[]
}

export interface SessionSummary {
  id: string
  title: string
  status: 'running' | 'done' | 'stopped' | 'error'
  startedAt: string
  ms?: number
}

/** JSONL event log per session. Approval tokens and keys are never stored. */
export interface SessionStore {
  append(sessionId: string, event: PilotEvent): Promise<void>
  read(sessionId: string): Promise<PilotEvent[]>
  list(): Promise<SessionSummary[]>
}

export interface Pilot {
  tools(): ToolSpec[]
  run(sessionId: string, message: string, opts?: { signal?: AbortSignal; context?: PilotContext }): AsyncIterable<PilotEvent>
  /**
   * Live settings evaluation. Emits a `settings_diff` right away from
   * deterministic code (no model call), then an optional short narration.
   */
  switchMachine(sessionId: string, from: PilotMachine, to: PilotMachine, opts?: { narrate?: boolean; signal?: AbortSignal }): AsyncIterable<PilotEvent>
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void>
  setPolicy(policy: PermissionPolicy): void
  policy(): PermissionPolicy
}

// ---------------------------------------------------------------------------
// Host interfaces

/** HTTP request built by a provider adapter. It never carries the key; the host adds it. */
export interface LlmHttpRequest {
  provider: string
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

export interface LlmTransport {
  /** True when a key for this provider is present in the keychain or environment. */
  available(provider: string): Promise<boolean>
  /** Streams the raw response body (SSE bytes). Rejects with the HTTP status on a non-2xx reply. */
  stream(req: LlmHttpRequest, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

export interface ApprovalHost {
  /** Registers a pending request with the broker so a later grant can be bound to it. */
  register(req: ApprovalRequest): Promise<void>
  /**
   * Called only after a verified human decision: the approval card's button, or a
   * paired phone's signed decision (a remote card). Never from model output.
   */
  grant(requestId: string): Promise<ApprovalToken>
  /**
   * Like `grant`, also saying whether the person confirmed the bed is clear. A hub refuses a card start (Pilot, MCP,
   * phone, inbox, queue, schedule) with `bed_check` without it. Pass true only after the person said so on a card that asked.
   * A hub may answer a queued or scheduled plate with `{queued: true}` and start it itself.
   */
  grantWith?(requestId: string, opts: { bedClear: boolean }): Promise<ApprovalToken | { queued: true; itemId: string; notBefore: string; approvedUntil: string }>
  deny(requestId: string, reason?: string): Promise<void>
}

/** True when the request starts a print, so the card must ask whether the bed is clear. */
export function startsPrint(req: Pick<ApprovalRequest, 'actions'>): boolean {
  return req.actions.some((a) => a.action === 'printer.start')
}

/**
 * Grants a request after a verified human decision. `bedClear` is passed on (never invented): false when the card did not ask or
 * the person did not confirm. A hub that kept the approval for a queued start returns no token, which is an error here.
 */
export async function grantApproval(host: Pick<ApprovalHost, 'grant' | 'grantWith'>, req: Pick<ApprovalRequest, 'id' | 'actions'>, bedClear: boolean): Promise<ApprovalToken> {
  if (!host.grantWith) return host.grant(req.id)
  const out = await host.grantWith(req.id, { bedClear: bedClear && startsPrint(req) })
  if ('queued' in out) throw new Error('The hub kept this approval and will start the plate itself')
  return out
}

/** The check every side-effect host call runs (sx-permit in Rust, the TS broker in fleet-sim). */
export interface ApprovalVerifier {
  /** Consumes the action on success, so a second call with the same token and action fails. */
  verify(token: ApprovalToken, action: SideEffectAction, target: string, paramsHash: string): Promise<ApprovalCheck>
}

// ---------------------------------------------------------------------------
// Parameter hashing shared by Pilot, the brokers and every host

/** JSON with object keys sorted at every level, no whitespace. `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** Lowercase hex SHA-256 of `canonicalJson(params)`. Uses Web Crypto (browser, Node, Tauri webview). */
export async function hashParams(params: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(params))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
