// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keep this file free of DOM and CSS imports.
// mimir's working steps in one loop (owner's pick, 2026-11-12): a reply's thoughts and tool steps fold into one live block while it works, and
// into one line when the work is done. Cards that wait for the person, errors, the result card and mimir's reply text
// stay outside; one landing mid-turn closes the loop there, and the next working step opens a new one.
import { changesDesign, createdPart } from './part'
import type { Block, ToolRowModel } from './reduce'
import type { StepWords } from './tool-group'

/** One tool step in a loop. */
export interface LoopStep {
  row: ToolRowModel
  /** The part the step works on: its plan feature, else the name it gives, else the part before it. */
  part: string
}

/** A tool step, a thought, or a note (a model switch, a permission line). */
export type LoopItem =
  | { kind: 'step'; step: LoopStep }
  | { kind: 'think'; block: Extract<Block, { kind: 'think' }> }
  | { kind: 'note'; block: Extract<Block, { kind: 'model' | 'perm' }> }

export interface Loop {
  id: string
  items: LoopItem[]
}

/** A turn's blocks with its working steps folded: blocks shown as they are, and loops. */
export type Segment = { kind: 'block'; block: Block } | { kind: 'loop'; loop: Loop } | { kind: 'made'; row: ToolRowModel }

const CHECKS: ReadonlySet<string> = new Set(['design.check', 'geom.fit_check', 'geom.interference'])
/** The plain heading of the group the checks go under. */
export const CHECK_GROUP = 'Check'

function argsOf(row: ToolRowModel): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(row.args || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const named = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function partOf(row: ToolRowModel, before: string | null): string {
  if (CHECKS.has(row.tool)) return CHECK_GROUP
  const a = argsOf(row)
  return named(a['feature']) ?? named(a['name']) ?? before ?? 'Steps'
}

/**
 * Folds a turn's blocks into segments. `words` decides which tool calls are steps: a call with no words (a question, a
 * sheet, a plan, a lookup) shows as its own card, so it is no step. A call that made a part shows as its card.
 */
export function loopSegments(blocks: readonly Block[], words: StepWords): Segment[] {
  const out: Segment[] = []
  let open: Loop | null = null
  let part: string | null = null
  const close = (): void => {
    open = null
  }
  const loop = (id: string): Loop => {
    if (!open) {
      open = { id: `loop-${id}`, items: [] }
      out.push({ kind: 'loop', loop: open })
    }
    return open
  }
  for (const b of blocks) {
    switch (b.kind) {
      case 'think': {
        loop(b.id).items.push({ kind: 'think', block: b })
        break
      }
      case 'tools': {
        for (const row of b.rows) {
          if (createdPart(row)) {
            close()
            out.push({ kind: 'made', row })
            continue
          }
          if (words(row) === null) continue
          part = partOf(row, part)
          loop(row.callId).items.push({ kind: 'step', step: { row, part } })
        }
        break
      }
      case 'model':
      case 'perm': {
        if (open) (open as Loop).items.push({ kind: 'note', block: b })
        else out.push({ kind: 'block', block: b })
        break
      }
      // mimir's own text stays in the chat, and closes the loop there (owner, 2026-11-12)
      default:
        close()
        out.push({ kind: 'block', block: b })
    }
  }
  return out
}

export const loopSteps = (l: Loop): LoopStep[] => l.items.flatMap((i) => (i.kind === 'step' ? [i.step] : []))

/** True when a step of the loop changed a design: the closed line says Built. */
export function loopBuilt(l: Loop): boolean {
  return loopSteps(l).some((s) => s.row.state === 'ok' && changesDesign(s.row.tool))
}

/** True when the run stopped inside the loop: a step it left open closes as Stopped or Canceled. */
export function loopStopped(l: Loop): boolean {
  return loopSteps(l).some((s) => s.row.state === 'bad' && (s.row.summary === 'Stopped' || s.row.summary === 'Canceled'))
}

/** The loop's time in ms: from its first start to its last finish when the clock was kept, else the sum of its parts. */
export function loopMs(l: Loop): number {
  const spans = l.items.flatMap((i): { at: number | undefined; ms: number }[] => {
    if (i.kind === 'step') return [{ at: i.step.row.at, ms: i.step.row.ms ?? 0 }]
    if (i.kind === 'think') return [{ at: i.block.at, ms: i.block.ms ?? 0 }]
    return []
  })
  if (spans.length === 0) return 0
  if (spans.every((s) => s.at !== undefined && s.at > 0)) {
    const start = Math.min(...spans.map((s) => s.at!))
    const end = Math.max(...spans.map((s) => s.at! + s.ms))
    return Math.max(0, end - start)
  }
  return spans.reduce((t, s) => t + s.ms, 0)
}

/** "35 s", "2 min 35 s". */
export function fmtTotal(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m} min ${s % 60} s` : `${s} s`
}

/** A step's or a part's time: "0.4 s" under 10 s, then whole seconds, then minutes. */
export function fmtStep(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`
  return fmtTotal(ms)
}

/** The closed line: "Built in 14 steps, 2 min 35 s", "Done in 3 steps, 4.2 s", or "Stopped after 5 steps, 40 s". */
export function loopLine(l: Loop, stopped: boolean): string {
  const n = loopSteps(l).length
  const steps = n === 1 ? '1 step' : `${n} steps`
  const time = fmtStep(loopMs(l))
  if (stopped) return `Stopped after ${steps}, ${time}`
  return `${loopBuilt(l) ? 'Built' : 'Done'} in ${steps}, ${time}`
}

/** The live label: the step running now, a thought under way, or the last thing done; never a tool's own name. */
export function loopLabel(l: Loop, words: StepWords): string {
  const last = l.items.at(-1)
  if (!last) return 'Thinking'
  if (last.kind === 'think') return 'Thinking'
  const running = loopSteps(l).find((s) => s.row.state === 'running')
  if (running) return words(running.row)?.doing ?? 'Working'
  const done = loopSteps(l).at(-1)
  return done ? (words(done.row)?.done ?? 'Working') : 'Thinking'
}

/** The loop's steps by part, in order, with each part's time. */
export function loopGroups(l: Loop): { part: string; ms: number; items: LoopItem[] }[] {
  const groups: { part: string; ms: number; items: LoopItem[] }[] = []
  let pending: LoopItem[] = []
  for (const i of l.items) {
    if (i.kind !== 'step') {
      pending.push(i)
      continue
    }
    let g = groups.at(-1)
    if (!g || g.part !== i.step.part) {
      g = { part: i.step.part, ms: 0, items: [] }
      groups.push(g)
    }
    g.items.push(...pending, i)
    pending = []
    g.ms += i.step.row.ms ?? 0
  }
  const g = groups.at(-1)
  if (pending.length) {
    if (g) g.items.push(...pending)
    else groups.push({ part: '', ms: 0, items: pending })
  }
  return groups
}
