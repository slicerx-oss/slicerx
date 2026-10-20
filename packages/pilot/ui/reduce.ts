// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keep this file free of DOM and CSS imports: the phone app imports it.
// Folds PilotEvents into the transcript the chat renders. Pure: the caller passes the clock.
import type {
  ApprovalDecision,
  ApprovalRequest,
  Citation,
  PermissionClass,
  PilotAttachment,
  PilotChoice,
  PilotEvent,
  PilotLookup,
  PilotSheet,
  PilotSheetAnswer,
  PilotSheetBind,
  PluginLoad,
  PrintRun,
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
  /** The tool's structured result, for cards built from it (a created part). */
  output?: unknown
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
  | { kind: 'think'; id: string; text: string; ms: number | null }
  | { kind: 'say'; id: string; text: string; streaming: boolean }
  | { kind: 'plan'; id: string; steps: string[] }
  | { kind: 'tools'; id: string; rows: ToolRowModel[] }
  | { kind: 'diff'; id: string; diff: SettingsDiff }
  | { kind: 'perm'; id: string; permission: PermissionClass; mode: 'allow' | 'off'; message: string }
  | { kind: 'model'; id: string; model: string; label: string; reason: 'request' | 'tool' | 'struggle' }
  /** `builtin`: the runtime's own tool asked, so the host may show its own card in place of the approval card. */
  | { kind: 'approval'; id: string; request: ApprovalRequest; resolution: ApprovalResolution | null; replay: boolean; source?: ToolSource; builtin?: boolean }
  | { kind: 'lookup'; id: string; lookup: PilotLookup }
  | { kind: 'choice'; id: string; askId: string; title: string; question: string; choices: PilotChoice[]; picked: string | null; replay: boolean }
  | { kind: 'sheet'; id: string; sheet: PilotSheet; answer: PilotSheetAnswer | null; replay: boolean; bound?: { design: string; binds: PilotSheetBind[] } }
  | { kind: 'summary'; id: string; title: string; rows: [string, string][]; stopped: boolean; ms: number | null }
  | { kind: 'citations'; id: string; items: Citation[] }
  | { kind: 'error'; id: string; message: string; retryable: boolean; code?: string }
  /**
   * A place for the print run's card: the slice it made, or the print it started. The card reads `Transcript.printRun`
   * while it is the latest of its kind; `run` is the run as it was when the card was made, which a card keeps once a
   * later slice has replaced its slice. A progress card's `run` follows its own job until the job ends, so it keeps
   * how its print ended once a later print is the chat's.
   */
  | { kind: 'run'; id: string; stage: 'slice' | 'progress'; run?: PrintRun }

export type BlockKind = Block['kind']

export interface Turn {
  id: string
  /** The person's message; null for turns that start from a saved log or a machine switch without one. */
  user: string | null
  /** Where the message was sent from, shown above the bubble. */
  where: string | null
  /** Files the person added to the message. */
  attachments: PilotAttachment[]
  blocks: Block[]
  /** The plugins (integrations) this reply called a tool of, by id, in first-use order. */
  used?: string[]
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
  /** The chat's print run as the runtime last reported it, or null before it reported one. */
  printRun: PrintRun | null
  /** The person holds the run going: it waits before its next step. A run's end lets go. */
  held: boolean
}

const EMPTY_METER: Meter = { steps: 0, toolCalls: 0, tokens: 0, elapsedMs: 0 }

export function emptyTranscript(): Transcript {
  return { turns: [], seq: 0, status: 'idle', meter: EMPTY_METER, clockStart: null, plugins: null, model: null, replaying: false, printRun: null, held: false }
}

/** Marks turns created from here on as replayed (saved log) or live. */
export function setReplaying(state: Transcript, replaying: boolean): Transcript {
  return state.replaying === replaying ? state : { ...state, replaying }
}

/**
 * A transcript brought back after a reload, as it was when its last run ended. It is history now: cards in it can no
 * longer be answered and nothing is streaming.
 */
export function restoredTranscript(t: Transcript): Transcript {
  const turns = t.turns.map((turn) => ({
    ...turn,
    replay: true,
    blocks: turn.blocks.map((b): Block => (b.kind === 'approval' || b.kind === 'choice' || b.kind === 'sheet' ? { ...b, replay: true } : b.kind === 'say' ? { ...b, streaming: false } : b)),
  }))
  // a transcript saved before print runs has no printRun key
  return { ...t, turns, status: t.status === 'running' ? 'stopped' : t.status, clockStart: null, replaying: false, printRun: t.printRun ?? null, held: false }
}

/** Each message the person sent and mimir's words in reply, for picking the conversation back up. */
export function transcriptTurns(t: Transcript): { user: string; reply: string }[] {
  return t.turns.flatMap((turn) => (turn.user === null ? [] : [{ user: turn.user, reply: turn.blocks.flatMap((b) => (b.kind === 'say' ? [b.text] : [])).join('\n').trim() }]))
}

/** Opens a new turn: the person's bubble (when there is a message) and an empty mimir reply under it. */
export function startTurn(state: Transcript, opts: { user?: string | null; where?: string | null; attachments?: PilotAttachment[] }, now: number): Transcript {
  const seq = state.seq + 1
  const turn: Turn = { id: `t${seq}`, user: opts.user ?? null, where: opts.where ?? null, attachments: opts.attachments ?? [], blocks: [], replay: state.replaying }
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
    // A sheet nobody answered before the run ended can no longer be: it closes as not confirmed.
    if (b.kind === 'sheet' && b.answer === null) {
      return { ...b, answer: { confirmed: false, values: Object.fromEntries(b.sheet.dims.map((d) => [d.key, d.value])), changed: [] } }
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

/**
 * The run a card shows: the latest run while its slice (or, for a progress card, its job) is the latest, else the run
 * it was made with. A progress card's run follows its own job to the end, so a restored chat with two prints shows each
 * print as it ended.
 */
export function runShown(b: Extract<Block, { kind: 'run' }>, latest: PrintRun | null): PrintRun | null {
  if (b.stage === 'slice') return b.run?.slice && b.run.slice.sliceId !== latest?.slice?.sliceId ? b.run : latest
  return b.run?.job && b.run.job.startedAt !== latest?.job?.startedAt ? b.run : latest
}

/** Gives the progress card of `run`'s job the run as it is now; turns without that card stay as they are. */
function withOwnJob(turns: readonly Turn[], run: PrintRun): Turn[] {
  const startedAt = run.job?.startedAt
  const mine = (b: Block): boolean => b.kind === 'run' && b.stage === 'progress' && b.run?.job != null && b.run.job.startedAt === startedAt
  return turns.map((t) => (t.blocks.some(mine) ? { ...t, blocks: t.blocks.map((b) => (mine(b) ? { ...b, run } : b)) } : t))
}

/** A turn of mimir's own with no message, opened without starting a run (a line about the print run between runs). */
function quietTurn(s: Draft): Draft {
  const seq = s.seq + 1
  const turn: Turn = { id: `t${seq}`, user: null, where: null, attachments: [], blocks: [], replay: s.replaying }
  return { ...s, seq, turns: [...s.turns, turn] }
}

/**
 * Keeps the latest run. A slice with a new id adds a slice card to the current turn, and a job with a new start time adds
 * a progress card; the same slice or job reported again adds nothing.
 */
function foldPrintRun(state: Transcript, run: PrintRun): Transcript {
  const prev = state.printRun
  // loose checks: a run read back from a log may lack a key
  const newSlice = run.slice != null && run.slice.sliceId !== prev?.slice?.sliceId
  const newJob = run.job != null && run.job.startedAt !== prev?.job?.startedAt
  let s: Draft = { ...state, printRun: run }
  // the same job moved or ended: its card keeps it, even once a later print is the chat's
  if (!newJob && run.job != null) s = { ...s, turns: withOwnJob(s.turns, run) }
  if (!newSlice && !newJob) return s
  if (s.turns.length === 0) s = quietTurn(s)
  if (newSlice) s = append(settleStreams(s), (id) => ({ kind: 'run', id, stage: 'slice', run }), false)
  if (newJob) s = append(settleStreams(s), (id) => ({ kind: 'run', id, stage: 'progress', run }), false)
  return s
}

/**
 * A line about the print run (how a print ended): between runs it is a turn of its own with no bubble; during a run it
 * is a line in the reply under way, so the run's later events stay in their own turn.
 */
function foldRunNote(state: Transcript, text: string): Transcript {
  const s = state.status === 'running' && state.turns.length > 0 ? settleStreams(state) : quietTurn(state)
  return append(s, (id) => ({ kind: 'say', id, text, streaming: false }), false)
}

/** Folds one PilotEvent into the transcript. `now` is the local clock in ms (used for times shown to the person). */
export function reduceTranscript(state: Transcript, event: PilotEvent, now = 0): Transcript {
  // the print run arrives between runs too, so it never opens a run's turn
  if (event.type === 'print_run') return foldPrintRun(state, event.run)
  if (event.type === 'run_note') return foldRunNote(state, event.text)
  // a hold is about the run going, not a line in it, and a run that is over is never held
  if (event.type === 'held') return { ...state, held: event.on && state.status === 'running' }
  let s = ensureTurn(state, now)
  switch (event.type) {
    case 'start': {
      const t = lastTurn(s)
      // A new run from a saved log (or a second run in one log) opens its own turn.
      if (t && (t.blocks.length > 0 || s.status !== 'running')) s = startTurn(s, {}, now)
      return { ...s, status: 'running', model: event.model, clockStart: s.clockStart ?? now }
    }
    // Integration status lives in Settings, not in the replies; the list is kept for the inspector and the used pill.
    case 'plugins':
      return { ...s, plugins: event.plugins }
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
      // a plugin tool is named `<plugin>.<tool>`
      const plugin = event.source === 'plugin' ? event.tool.split('.')[0] : undefined
      if (plugin && !lastTurn(s)?.used?.includes(plugin)) s = withLastTurn(s, (t) => ({ ...t, used: [...(t.used ?? []), plugin] }))
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
        ...(event.output !== undefined ? { output: event.output } : {}),
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
      return append(settleStreams(s), (id) => ({ kind: 'approval', id, request: event.request, resolution: null, replay, ...(event.source ? { source: event.source } : {}), ...(event.builtin === true ? { builtin: true } : {}) }), true)
    }
    case 'ask': {
      const replay = lastTurn(s)?.replay ?? false
      return append(settleStreams(s), (id) => ({ kind: 'choice', id, askId: event.askId, title: event.title, question: event.question, choices: event.choices, picked: null, replay }), true)
    }
    case 'lookup':
      return append(settleStreams(s), (id) => ({ kind: 'lookup', id, lookup: event.lookup }), false)
    case 'sheet': {
      const replay = lastTurn(s)?.replay ?? false
      return append(settleStreams(s), (id) => ({ kind: 'sheet', id, sheet: event.sheet, answer: null, replay }), true)
    }
    case 'sheet_answered':
      return mapBlocks(s, (b) => (b.kind === 'sheet' && b.sheet.id === event.sheetId && b.answer === null ? { ...b, answer: event.answer } : b))
    case 'sheet_bound':
      return mapBlocks(s, (b) => (b.kind === 'sheet' && b.sheet.id === event.sheetId ? { ...b, bound: { design: event.design, binds: event.binds } } : b))
    case 'ask_answered':
      return mapBlocks(s, (b) => (b.kind === 'choice' && b.askId === event.askId && b.picked === null ? { ...b, picked: event.choiceId } : b))
    case 'approval_resolved':
      // Policy approvals have no card; their permission note already says so.
      return mapBlocks(s, (b) =>
        b.kind === 'approval' && b.request.id === event.requestId && b.resolution === null
          ? { ...b, resolution: { decision: event.decision, by: event.by, at: now } }
          : b,
      )
    case 'summary':
      return append(settleStreams(s), (id) => ({ kind: 'summary', id, title: event.title, rows: event.rows, stopped: event.stopped, ms: s.clockStart === null ? null : now - s.clockStart }), true)
    case 'model_switch':
      return append(settleStreams(s), (id) => ({ kind: 'model', id, model: event.model, label: event.label, reason: event.reason }), true)
    case 'usage':
      return { ...s, meter: { ...s.meter, tokens: s.meter.tokens + event.inputTokens + event.outputTokens } }
    case 'error':
      return append(settleStreams(s), (id) => ({ kind: 'error', id, message: event.message, retryable: event.retryable, ...(event.code ? { code: event.code } : {}) }), false)
    case 'done':
      return { ...finishRun(s, event.stopReason, event.ms, now), held: false }
  }
}

/** Folds a whole event list, as when a saved log is shown at once. */
export function foldEvents(events: readonly PilotEvent[], state: Transcript = emptyTranscript(), now = 0): Transcript {
  let s = state
  for (const e of events) s = reduceTranscript(s, e, now)
  return s
}
