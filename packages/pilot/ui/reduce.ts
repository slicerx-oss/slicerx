// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keep this file free of DOM and CSS imports: the phone app imports it.
// Folds PilotEvents into the transcript the chat renders. Pure: the caller passes the clock.
import type {
  ApprovalDecision,
  ApprovalRequest,
  Citation,
  PermissionClass,
  PilotEvent,
  PluginLoad,
  SettingsDiff,
  ToolDisplay,
  ToolSource,
} from '@slicerx/contracts'

export interface ToolRowModel {
  callId: string
  tool: string
  source: ToolSource
  args: string
  /** One line summary the model gave with the call, shown while it runs. */
  callSummary: string | undefined
  state: 'running' | 'ok' | 'bad'
  summary: string | undefined
  display: ToolDisplay[]
  progress: { line: string; fraction: number | undefined }[]
  ms: number | undefined
  untrusted: boolean
}

export interface ApprovalResolution {
  decision: ApprovalDecision
  by: 'user' | 'policy' | 'expiry'
  /** Local clock, ms. */
  at: number
}

export type Block =
  | { kind: 'plugins'; id: string; plugins: PluginLoad[] }
  | { kind: 'think'; id: string; text: string; ms: number | null }
  | { kind: 'say'; id: string; text: string; streaming: boolean }
  | { kind: 'plan'; id: string; steps: string[] }
  | { kind: 'tools'; id: string; rows: ToolRowModel[] }
  | { kind: 'diff'; id: string; diff: SettingsDiff }
  | { kind: 'perm'; id: string; permission: PermissionClass; mode: 'allow' | 'off'; message: string }
  | { kind: 'approval'; id: string; request: ApprovalRequest; resolution: ApprovalResolution | null; replay: boolean }
  | { kind: 'summary'; id: string; title: string; rows: [string, string][]; stopped: boolean; ms: number | null }
  | { kind: 'citations'; id: string; items: Citation[] }
  | { kind: 'error'; id: string; message: string; retryable: boolean }

export type BlockKind = Block['kind']

export interface Turn {
  id: string
  /** The person's message; null for turns that start from a saved log or a machine switch without one. */
  user: string | null
  /** Where the message was sent from, shown above the bubble. */
  where: string | null
  blocks: Block[]
  /** Blocks came from a saved log, so approvals in it are not actionable. */
  replay: boolean
}

export type RunStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error'

export interface Meter {
  steps: number
  toolCalls: number
  tokens: number
  /** Settled elapsed time of the current run, ms. Live time is added from `clockStart` while running. */
  elapsedMs: number
}

export interface Transcript {
  turns: Turn[]
  seq: number
  status: RunStatus
  meter: Meter
  /** Local clock when the current run started, while it runs. */
  clockStart: number | null
  /** The latest plugin list the runtime reported. */
  plugins: PluginLoad[] | null
  model: string | null
  /** New turns are marked as replayed from a saved log. */
  replaying: boolean
}

const EMPTY_METER: Meter = { steps: 0, toolCalls: 0, tokens: 0, elapsedMs: 0 }

export function emptyTranscript(): Transcript {
  return { turns: [], seq: 0, status: 'idle', meter: EMPTY_METER, clockStart: null, plugins: null, model: null, replaying: false }
}

/** Marks turns created from here on as replayed (saved log) or live. */
export function setReplaying(state: Transcript, replaying: boolean): Transcript {
  return state.replaying === replaying ? state : { ...state, replaying }
}

/** Opens a new turn: the person's bubble (when there is a message) and an empty mimir reply under it. */
export function startTurn(state: Transcript, opts: { user?: string | null; where?: string | null }, now: number): Transcript {
  const seq = state.seq + 1
  const turn: Turn = { id: `t${seq}`, user: opts.user ?? null, where: opts.where ?? null, blocks: [], replay: state.replaying }
  return { ...state, seq, turns: [...state.turns, turn], status: 'running', meter: EMPTY_METER, clockStart: now }
}

/** Live elapsed time of the current run. */
export function elapsedMs(state: Transcript, now: number): number {
  return state.meter.elapsedMs + (state.status === 'running' && state.clockStart !== null ? Math.max(0, now - state.clockStart) : 0)
}

/** Tool rows still waiting for their result, for the inspector's busy highlight. */
export function runningTools(state: Transcript): { tool: string; source: ToolSource }[] {
  const out: { tool: string; source: ToolSource }[] = []
  const turn = state.turns.at(-1)
  if (!turn) return out
  for (const b of turn.blocks) if (b.kind === 'tools') for (const r of b.rows) if (r.state === 'running') out.push({ tool: r.tool, source: r.source })
  return out
}

/** Approval requests waiting for the person, newest last. */
export function pendingApprovals(state: Transcript): ApprovalRequest[] {
  const out: ApprovalRequest[] = []
  for (const t of state.turns) for (const b of t.blocks) if (b.kind === 'approval' && b.resolution === null && !b.replay) out.push(b.request)
  return out
}

// ---------------------------------------------------------------------------

type Draft = Transcript

function nextId(s: Draft): [Draft, string] {
  const seq = s.seq + 1
  return [{ ...s, seq }, `b${seq}`]
}

/** Makes sure there is a turn to write into; events from a saved log may arrive without one. */
function ensureTurn(s: Draft, now: number): Draft {
  if (s.turns.length > 0) return s
  return startTurn(s, {}, now)
}

function lastTurn(s: Draft): Turn | undefined {
  return s.turns.at(-1)
}

function lastBlock(s: Draft): Block | undefined {
  return lastTurn(s)?.blocks.at(-1)
}

function withLastTurn(s: Draft, fn: (t: Turn) => Turn): Draft {
  const t = lastTurn(s)
  if (!t) return s
  return { ...s, turns: [...s.turns.slice(0, -1), fn(t)] }
}

function replaceLastBlock(s: Draft, b: Block): Draft {
  return withLastTurn(s, (t) => ({ ...t, blocks: [...t.blocks.slice(0, -1), b] }))
}

/** Appends a block; `step` counts it on the meter. */
function append(s: Draft, make: (id: string) => Block, step: boolean): Draft {
  const [s1, id] = nextId(s)
  const b = make(id)
  const s2 = withLastTurn(s1, (t) => ({ ...t, blocks: [...t.blocks, b] }))
  return step ? { ...s2, meter: { ...s2.meter, steps: s2.meter.steps + 1 } } : s2
}

function mapBlocks(s: Draft, fn: (b: Block) => Block): Draft {
  let changed = false
  const turns = s.turns.map((t) => {
    let tChanged = false
    const blocks = t.blocks.map((b) => {
      const n = fn(b)
      if (n !== b) tChanged = true
      return n
    })
    if (!tChanged) return t
    changed = true
    return { ...t, blocks }
  })
  return changed ? { ...s, turns } : s
}

function mapRow(s: Draft, callId: string, fn: (r: ToolRowModel) => ToolRowModel): Draft {
  return mapBlocks(s, (b) => {
    if (b.kind !== 'tools' || !b.rows.some((r) => r.callId === callId)) return b
    return { ...b, rows: b.rows.map((r) => (r.callId === callId ? fn(r) : r)) }
  })
}

/** Closes open streams when something else happens in between. */
function settleStreams(s: Draft): Draft {
  return withLastTurn(s, (t) => {
    let changed = false
    const blocks = t.blocks.map((b) => {
      if (b.kind === 'say' && b.streaming) {
        changed = true
        return { ...b, streaming: false }
      }
      return b
    })
    return changed ? { ...t, blocks } : t
  })
}

function finishRun(s: Draft, stopReason: Extract<PilotEvent, { type: 'done' }>['stopReason'], ms: number, now: number): Draft {
  let out = settleStreams(s)
  // Thinking that never got its done event still folds.
  out = withLastTurn(out, (t) => ({
    ...t,
    blocks: t.blocks.map((b) => (b.kind === 'think' && b.ms === null ? { ...b, ms: 0 } : b)),
  }))
  // Rows and approvals left open by a canceled or failed run.
  out = mapBlocks(out, (b) => {
    if (b.kind === 'tools' && b.rows.some((r) => r.state === 'running')) {
      return { ...b, rows: b.rows.map((r) => (r.state === 'running' ? { ...r, state: 'bad' as const, summary: stopReason === 'canceled' ? 'Canceled' : 'Stopped' } : r)) }
    }
    if (b.kind === 'approval' && b.resolution === null) {
      return { ...b, resolution: { decision: { kind: 'deny', reason: 'canceled' }, by: 'user', at: now } }
    }
    return b
  })
  // "done in" on the run's summary comes from the runtime's own clock.
  out = withLastTurn(out, (t) => {
    const idx = t.blocks.findLastIndex((b) => b.kind === 'summary')
    const b = t.blocks[idx]
    if (!b || b.kind !== 'summary') return t
    return { ...t, blocks: t.blocks.map((x, i) => (i === idx ? { ...b, ms } : x)) }
  })
  const status: RunStatus = stopReason === 'end' ? 'done' : stopReason === 'error' ? 'error' : 'stopped'
  return { ...out, status, clockStart: null, meter: { ...out.meter, elapsedMs: ms } }
}

/** Folds one PilotEvent into the transcript. `now` is the local clock in ms (used for times shown to the person). */
export function reduceTranscript(state: Transcript, event: PilotEvent, now = 0): Transcript {
  let s = ensureTurn(state, now)
  switch (event.type) {
    case 'start': {
      const t = lastTurn(s)
      // A new run from a saved log (or a second run in one log) opens its own turn.
      if (t && (t.blocks.length > 0 || s.status !== 'running')) s = startTurn(s, {}, now)
      return { ...s, status: 'running', model: event.model, clockStart: s.clockStart ?? now }
    }
    case 'plugins': {
      s = { ...s, plugins: event.plugins }
      const existing = lastTurn(s)?.blocks.findLastIndex((b) => b.kind === 'plugins') ?? -1
      if (existing >= 0) {
        return withLastTurn(s, (t) => ({ ...t, blocks: t.blocks.map((b, i) => (i === existing && b.kind === 'plugins' ? { ...b, plugins: event.plugins } : b)) }))
      }
      // Only a first load is worth a line; later runs report plugins that are already up.
      if (!event.plugins.some((p) => p.state === 'loading')) return s
      return append(s, (id) => ({ kind: 'plugins', id, plugins: event.plugins }), false)
    }
    case 'thinking': {
      const b = lastBlock(s)
      if (b && b.kind === 'think' && b.ms === null) return replaceLastBlock(s, { ...b, text: b.text + event.delta })
      return append(settleStreams(s), (id) => ({ kind: 'think', id, text: event.delta, ms: null }), true)
    }
    case 'thinking_done': {
      const t = lastTurn(s)
      const idx = t ? t.blocks.findLastIndex((b) => b.kind === 'think' && b.ms === null) : -1
      if (!t || idx < 0) return s
      return withLastTurn(s, (turn) => ({ ...turn, blocks: turn.blocks.map((b, i) => (i === idx && b.kind === 'think' ? { ...b, ms: event.ms } : b)) }))
    }
    case 'text': {
      const b = lastBlock(s)
      if (b && b.kind === 'say' && b.streaming) return replaceLastBlock(s, { ...b, text: b.text + event.delta })
      return append(s, (id) => ({ kind: 'say', id, text: event.delta, streaming: true }), true)
    }
    case 'text_done':
      return settleStreams(s)
    case 'plan':
      return append(settleStreams(s), (id) => ({ kind: 'plan', id, steps: event.steps }), false)
    case 'tool_call': {
      s = settleStreams(s)
      const row: ToolRowModel = {
        callId: event.callId,
        tool: event.tool,
        source: event.source,
        args: event.args ?? '',
        callSummary: event.summary,
        state: 'running',
        summary: undefined,
        display: [],
        progress: [],
        ms: undefined,
        untrusted: false,
      }
      s = { ...s, meter: { ...s.meter, toolCalls: s.meter.toolCalls + 1, steps: s.meter.steps + 1 } }
      const b = lastBlock(s)
      // Consecutive calls share one group; anything in between starts a new one.
      if (b && b.kind === 'tools') return replaceLastBlock(s, { ...b, rows: [...b.rows, row] })
      return append(s, (id) => ({ kind: 'tools', id, rows: [row] }), false)
    }
    case 'tool_progress':
      return mapRow(s, event.callId, (r) => ({ ...r, progress: [...r.progress, { line: event.line, fraction: event.fraction }] }))
    case 'tool_result':
      return mapRow(s, event.callId, (r) => ({
        ...r,
        state: event.ok ? 'ok' : 'bad',
        summary: event.summary,
        display: event.display ?? [],
        ms: event.ms,
        untrusted: event.untrusted === true,
      }))
    case 'settings_diff':
      return append(settleStreams(s), (id) => ({ kind: 'diff', id, diff: event.diff }), true)
    case 'citations': {
      const b = lastBlock(s)
      if (b && b.kind === 'citations') {
        const items = [...b.items]
        for (const c of event.items) if (!items.some((x) => x.id === c.id)) items.push(c)
        return replaceLastBlock(s, { ...b, items })
      }
      return append(settleStreams(s), (id) => ({ kind: 'citations', id, items: event.items }), false)
    }
    case 'permission_note':
      return append(settleStreams(s), (id) => ({ kind: 'perm', id, permission: event.permission, mode: event.mode, message: event.message }), true)
    case 'approval_request': {
      const replay = lastTurn(s)?.replay ?? false
      return append(settleStreams(s), (id) => ({ kind: 'approval', id, request: event.request, resolution: null, replay }), true)
    }
    case 'approval_resolved':
      // Policy approvals have no card; their permission note already says so.
      return mapBlocks(s, (b) =>
        b.kind === 'approval' && b.request.id === event.requestId && b.resolution === null
          ? { ...b, resolution: { decision: event.decision, by: event.by, at: now } }
          : b,
      )
    case 'summary':
      return append(settleStreams(s), (id) => ({ kind: 'summary', id, title: event.title, rows: event.rows, stopped: event.stopped, ms: s.clockStart === null ? null : now - s.clockStart }), true)
    case 'usage':
      return { ...s, meter: { ...s.meter, tokens: s.meter.tokens + event.inputTokens + event.outputTokens } }
    case 'error':
      return append(settleStreams(s), (id) => ({ kind: 'error', id, message: event.message, retryable: event.retryable }), false)
    case 'done':
      return finishRun(s, event.stopReason, event.ms, now)
  }
}

/** Folds a whole event list, as when a saved log is shown at once. */
export function foldEvents(events: readonly PilotEvent[], state: Transcript = emptyTranscript(), now = 0): Transcript {
  let s = state
  for (const e of events) s = reduceTranscript(s, e, now)
  return s
}
