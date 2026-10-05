// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs mimir tools for MCP clients under mimir's permission model.
// Reads run directly. Anything else is looked up in the user's policy: Off
// refuses, Allow grants through the approval broker, Ask first asks the user
// through MCP elicitation or returns an approval request that the client must
// confirm with slicerx_approve. The host verifies the single-use token on
// every side effect, so a tool cannot act beyond what was approved.
import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ApprovalRequest, ApprovalToken, PermissionClass, PermissionPolicy } from '@slicerx/contracts'
import { grantApproval, hashParams, PERMISSION_LABELS } from '@slicerx/contracts'
import { buildApprovalRequest, decide, TOKEN_TTL_MS, toolMessage, type AgentWork, type ApprovalBroker, type PilotTool, type ToolContext, type ToolOutput } from '@slicerx/pilot'
import type { ActionLog } from './actionlog'

export interface PendingCall {
  tool: PilotTool<unknown>
  input: unknown
  request: ApprovalRequest
  expiresMs: number
  /** Only a person in SlicerX or on the phone can approve it (needsPerson); slicerx_approve can only decline it. */
  personOnly?: boolean
  /** For a person-only request the hub runs: how it went, once the hub reports it. */
  outcome?: ApprovalDone
}

/** The hub's report on person-only work it ran (sx-link `approval.done`). */
export interface ApprovalDone {
  requestId: string
  ok: boolean
  code?: string
  message?: string
}

/**
 * The hub's side of person-only requests (link mode): register the card together with the
 * work the hub runs once a person approves it, and hear how the work went.
 */
export interface PersonHandOff {
  register(request: ApprovalRequest, work: AgentWork): Promise<void>
  onDone(cb: (d: ApprovalDone) => void): () => void
}

/**
 * Host calls that make a printer move or heat on their own: starting a print
 * (a queue-start or a scheduled start includes printer.start), resuming one and
 * sending G-code, and changing a running print's temperatures, fans or speed.
 * No MCP path approves these, not elicitation, not slicerx_approve and not an
 * Allow in the policy file: a person taps approve on a SlicerX surface. Pause and
 * cancel stop a printer, so they stay approvable here. The same list as the hub's
 * (sx-link roles.rs PERSON_ONLY).
 */
const PERSON_ONLY_ACTIONS = new Set<string>(['printer.start', 'printer.resume', 'printer.gcode', 'printer.adjust'])

// Home Assistant service calls switch power, so they wait for a person too, as on the hub.
export function needsPerson(req: Pick<ApprovalRequest, 'actions'>): boolean {
  return req.actions.some((a) => PERSON_ONLY_ACTIONS.has(a.action) || (a.action === 'plugin.call' && a.target === 'home-assistant'))
}

export const PERSON_ONLY_NOTE =
  'Starting, resuming, sending G-code, changing a running print or switching power needs a person to approve it in SlicerX or on the phone. It cannot be approved through MCP. The request is registered; ask the user to approve it there.'

/** Progress lines a long tool sends, as MCP progress notifications when the client asked for them. */
export type ToolProgress = (line: string, fraction?: number) => void

export interface GateDeps {
  policy: PermissionPolicy
  policyPath: string | undefined
  broker: ApprovalBroker
  log: ActionLog
  pending: Map<string, PendingCall>
  /** A note added to a tool's result, such as "these printers are simulated". */
  annotate?(toolName: string): string | undefined
  /** Builds the context a tool runs with; `token` is set only after approval. */
  context(token: ApprovalToken | undefined, signal: AbortSignal, progress?: ToolProgress): ToolContext
  now(): number
  /** Link mode: where person-only requests go, with their work. */
  handOff?: PersonHandOff
  /** Person-only requests waiting for the hub's report, by request id. Shared by every session. */
  waiting?: Map<string, (d: ApprovalDone) => void>
}

const CHARACTER_LIMIT = 25_000

/** `printer.queue` becomes `slicerx_printer_queue`. */
export function mcpName(pilotName: string): string {
  return `slicerx_${pilotName.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`
}

function toResult(tool: PilotTool<unknown>, out: ToolOutput, extra: Record<string, unknown> = {}): CallToolResult {
  const data: Record<string, unknown> = {
    ok: out.ok !== false,
    summary: out.summary,
    ...(out.output !== undefined ? { output: out.output } : {}),
    ...(out.diff ? { diff: out.diff } : {}),
    ...(out.report ? { report: out.report } : {}),
    ...(out.citations?.length ? { citations: out.citations } : {}),
    ...extra,
    ...(out.ok === false ? { error: { code: 'invalid_input', message: out.summary } } : {}),
  }
  // The same text mimir sends its own model: printer and file output is wrapped and marked as data.
  let text = toolMessage(out)
  if (text.length > CHARACTER_LIMIT) text = `${text.slice(0, CHARACTER_LIMIT)}\n[truncated]`
  return { content: [{ type: 'text', text }], structuredContent: data, ...(out.ok === false ? { isError: true } : {}) }
}

function fail(message: string, data?: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }], ...(data ? { structuredContent: data } : {}) }
}

function errorText(e: unknown): string {
  const code = typeof e === 'object' && e !== null && 'code' in e ? `${String((e as { code: unknown }).code)}: ` : ''
  return `${code}${e instanceof Error ? e.message : String(e)}`
}

/** A thrown error as a refused call, with its code (ToolInputError and friends) or `internal_error`. */
function failFrom(e: unknown): CallToolResult {
  const raw = typeof e === 'object' && e !== null && 'code' in e ? (e as { code: unknown }).code : undefined
  const code = typeof raw === 'string' && raw !== '' ? raw : 'internal_error'
  const message = e instanceof Error ? e.message : String(e)
  return fail(`${code}: ${message}`, { error: { code, message } })
}

async function execute(
  deps: GateDeps,
  tool: PilotTool<unknown>,
  input: unknown,
  token: ApprovalToken | undefined,
  signal: AbortSignal,
  logBase: { permission: PermissionClass; inputHash: string; printerId: string | undefined; decision: 'read' | 'allowed' | 'approved'; by?: 'policy' | 'user' | 'client'; requestId?: string },
  progress?: ToolProgress,
): Promise<CallToolResult> {
  const entry = {
    tool: tool.name,
    permission: logBase.permission,
    input_hash: logBase.inputHash,
    ...(logBase.by ? { by: logBase.by } : {}),
    ...(logBase.requestId ? { request_id: logBase.requestId } : {}),
    ...(logBase.printerId ? { printer_id: logBase.printerId } : {}),
  }
  try {
    const out = await tool.run(input, deps.context(token, signal, progress))
    deps.log.append({ ...entry, decision: logBase.decision, ok: out.ok !== false, summary: out.summary.slice(0, 200) })
    const note = deps.annotate?.(tool.name)
    const result = toResult(tool, note ? { ...out, summary: `${out.summary}. ${note}` } : out, { ...(logBase.requestId ? { request_id: logBase.requestId } : {}), ...(note ? { note } : {}) })
    return result
  } catch (e) {
    deps.log.append({ ...entry, decision: 'failed', ok: false, summary: errorText(e).slice(0, 200) })
    return failFrom(e)
  }
}

/**
 * The answer to a bed_clear argument. Nothing sent over MCP can set the hub's
 * bed record: the user confirms the plate in SlicerX or on the phone.
 */
export const BED_CONFIRM_NOTE =
  'The build plate can only be confirmed clear in SlicerX or on the phone, never through MCP. The printer starts only if that confirmation is already on record; otherwise ask the user to confirm the plate there and try again.'

async function askUser(server: McpServer, request: ApprovalRequest): Promise<{ answer: 'approve' | 'deny' | 'unsupported' }> {
  if (!server.server.getClientCapabilities()?.elicitation) return { answer: 'unsupported' }
  try {
    const res = await server.server.elicitInput(
      {
        message: [
          request.title,
          ...request.lines,
          `Permission: ${PERMISSION_LABELS[request.permission as keyof typeof PERMISSION_LABELS]?.title ?? request.permission}`,
        ].join('\n'),
        requestedSchema: {
          type: 'object',
          properties: {
            approve: { type: 'boolean', title: 'Approve', description: 'Allow SlicerX to do this once' },
          },
          required: ['approve'],
        },
      },
      { timeout: TOKEN_TTL_MS },
    )
    const approved = res.action === 'accept' && res.content?.['approve'] === true
    return { answer: approved ? 'approve' : 'deny' }
  } catch {
    // The client advertised elicitation but could not complete it (for example stateless HTTP); fall back to a pending request.
    return { answer: 'unsupported' }
  }
}

/** Runs one call through the policy. */
export async function gatedCall(server: McpServer, deps: GateDeps, tool: PilotTool<unknown>, input: unknown, signal: AbortSignal, progress?: ToolProgress): Promise<CallToolResult> {
  const permission = tool.permissionFor?.(input) ?? tool.permission
  const printerId = tool.printerFor?.(input)
  const inputHash = await hashParams(input)
  let mode = decide(deps.policy, permission, printerId)
  if (permission === 'read') return execute(deps, tool, input, undefined, signal, { permission, inputHash, printerId, decision: 'read' }, progress)
  // A tool can need the user for a particular call even when its class is Allow, as in mimir's own runtime.
  if (mode === 'allow' && tool.mustAsk) {
    try {
      if ((await tool.mustAsk(input, deps.context(undefined, signal))).length) mode = 'ask'
    } catch (e) {
      return failFrom(e)
    }
  }

  const base = { tool: tool.name, permission, input_hash: inputHash, ...(printerId ? { printer_id: printerId } : {}) }
  if (mode === 'off') {
    deps.log.append({ ...base, decision: 'off', by: 'policy' })
    const label = PERMISSION_LABELS[permission as keyof typeof PERMISSION_LABELS]?.title ?? permission
    return fail(`"${label}" (${permission}) is Off in the user's permission policy${deps.policyPath ? ` (${deps.policyPath})` : ''}. Only the user can change it.`, { status: 'off', permission })
  }
  // mimir builds the request exactly as its own runtime does, so a call gates the same here as in the app.
  const expiresMs = deps.now() + TOKEN_TTL_MS
  let request: ApprovalRequest
  try {
    request = { ...(await buildApprovalRequest(tool, input, deps.context(undefined, signal), { id: randomUUID(), sessionId: 'mcp', expiresAt: new Date(expiresMs).toISOString() })), origin: 'mcp' }
  } catch (e) {
    return failFrom(e)
  }
  if (needsPerson(request)) {
    // The card goes to SlicerX with its work; the hub runs the work once a person approves.
    // With no hub (demo printers) nothing can approve it, and the request only waits.
    if (deps.handOff) {
      let work: AgentWork
      try {
        if (!tool.agentWork) throw new Error(`${mcpName(tool.name)} cannot be handed to SlicerX for approval.`)
        work = await tool.agentWork(input, deps.context(undefined, signal))
        await deps.handOff.register(request, work)
      } catch (e) {
        return failFrom(e)
      }
      const entry: PendingCall = { tool, input, request, expiresMs, personOnly: true }
      deps.waiting?.set(request.id, (d) => {
        entry.outcome = d
        deps.waiting?.delete(request.id)
        deps.log.append({ ...base, decision: d.ok ? 'approved' : 'failed', by: 'person', request_id: request.id, ok: d.ok, ...(d.message ? { summary: d.message.slice(0, 200) } : {}) })
      })
      deps.pending.set(request.id, entry)
    } else {
      try {
        await deps.broker.register(request)
      } catch (e) {
        return failFrom(e)
      }
      deps.pending.set(request.id, { tool, input, request, expiresMs, personOnly: true })
    }
    deps.log.append({ ...base, decision: 'needs_person', request_id: request.id })
    const data = { status: 'needs_person', request_id: request.id, title: request.title, lines: request.lines, permission, expires_at: request.expiresAt }
    const text = [`Needs a person: ${request.title}`, ...request.lines.map((l) => `- ${l}`), PERSON_ONLY_NOTE, `The request expires at ${request.expiresAt}.`].join('\n')
    return { content: [{ type: 'text', text }], structuredContent: data }
  }

  await deps.broker.register(request)

  if (mode === 'allow') {
    // No MCP path confirms the bed; the hub checks its own record before a start.
    const token = await grantApproval(deps.broker, request, false)
    return execute(deps, tool, input, token, signal, { permission, inputHash, printerId, decision: 'allowed', by: 'policy', requestId: request.id }, progress)
  }

  const { answer } = await askUser(server, request)
  if (answer === 'approve') {
    const token = await grantApproval(deps.broker, request, false)
    return execute(deps, tool, input, token, signal, { permission, inputHash, printerId, decision: 'approved', by: 'user', requestId: request.id }, progress)
  }
  if (answer === 'deny') {
    await deps.broker.deny(request.id)
    deps.log.append({ ...base, decision: 'denied', by: 'user', request_id: request.id })
    return fail('The user declined. Nothing was changed.', { status: 'denied', request_id: request.id })
  }

  deps.pending.set(request.id, { tool, input, request, expiresMs })
  deps.log.append({ ...base, decision: 'pending', request_id: request.id })
  const data = {
    status: 'approval_required',
    request_id: request.id,
    title: request.title,
    lines: request.lines,
    permission,
    expires_at: request.expiresAt,
  }
  const text = [
    `Approval needed: ${request.title}`,
    ...request.lines.map((l) => `- ${l}`),
    `Show this to the user. Only if they agree, call slicerx_approve with request_id "${request.id}" and approve: true. The request expires at ${request.expiresAt}.`,
  ].join('\n')
  return { content: [{ type: 'text', text }], structuredContent: data }
}

/** Resolves a pending approval request; approving runs the stored call once. */
export async function resolvePending(deps: GateDeps, requestId: string, approve: boolean, signal: AbortSignal, progress?: ToolProgress): Promise<CallToolResult> {
  const p = deps.pending.get(requestId)
  if (!p) return fail(`No pending request ${requestId}. It may have run, been declined or expired.`)
  deps.pending.delete(requestId)
  const base = { tool: p.tool.name, permission: p.request.permission, input_hash: p.request.paramsHash, request_id: requestId, ...(p.request.printerId ? { printer_id: p.request.printerId } : {}) }
  if (deps.now() >= p.expiresMs) {
    await deps.broker.deny(requestId)
    deps.log.append({ ...base, decision: 'expired' })
    return fail('The request expired. Call the tool again to get a new one.')
  }
  if (approve && p.personOnly) {
    // Declining stays possible; approving is for a person on a SlicerX surface.
    deps.pending.set(requestId, p)
    deps.log.append({ ...base, decision: 'refused', by: 'client' })
    return fail(PERSON_ONLY_NOTE, { status: 'needs_person', request_id: requestId })
  }
  if (!approve) {
    await deps.broker.deny(requestId)
    deps.log.append({ ...base, decision: 'denied', by: 'client' })
    return { content: [{ type: 'text', text: 'Declined. Nothing was changed.' }], structuredContent: { status: 'denied', request_id: requestId } }
  }
  const token = await grantApproval(deps.broker, p.request, false)
  return execute(
    deps,
    p.tool,
    p.input,
    token,
    signal,
    {
      permission: p.request.permission,
      inputHash: p.request.paramsHash,
      printerId: p.request.printerId,
      decision: 'approved',
      by: 'client',
      requestId,
    },
    progress,
  )
}
