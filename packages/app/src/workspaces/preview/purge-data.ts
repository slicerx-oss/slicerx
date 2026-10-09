// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The purge of each tool change at the chute, read from the slice's G-code: the flush the change G-code
// extrudes (or hands the firmware), its volume and weight, and when it plays inside the change. Loaded on
// first use: it reads the lines it needs of the G-code text (the header, the start and each change's flush), not the
// whole text; the viewport draws the blob from the plans and the playback bar reads out the grams (purge-view.ts).
import { SXPV_SEGMENT, SXPV_SEGMENT_BYTES, type Host, type PreviewBuffers } from '@slicerx/contracts'
import { changeSequence, flushOf, printedTop, purgeFromTools, purgeGrams, purgeVolume, purgeWindow, type ToolChangerSpec } from '@slicerx/viewport'
import type { Timeline } from '../../lib/preview-timeline'
import { lineOfSegment, lineText, windows, type LineIndex, type LineSource } from './gcode-lines'
import { holdText } from './gcode-source'
import { purgeView, type PlayPurge } from './purge-view'

/** Line text by number: the whole text, or the windows of it a reader fetched (other lines read as empty). */
export interface Lines {
  count: number
  text(n: number): string
}

function linesOf(text: LineIndex | Lines): Lines {
  if ('text' in text) return text
  return { count: text.count, text: (n) => lineText(text, n) }
}

/** Lines over windows of a text of `count` lines; a line no window holds reads as empty. */
export function windowLines(count: number, wins: LineIndex[]): Lines {
  return {
    count,
    text(n) {
      for (const w of wins) {
        const t = lineText(w, n)
        if (t) return t
      }
      return ''
    },
  }
}

const HEADER_LINES = 400
const TAIL_LINES = 3000
const START_LINES = 5000

/** Per filament numbers from a G-code comment such as `; filament_density: 1.24,1.26` or `; filament_diameter = 1.75`. */
function headerList(ix: Lines, key: string): number[] | null {
  const re = new RegExp(`^;\\s*${key}\\s*[:=]\\s*([\\d.,\\s]+)$`)
  const scan = (a: number, b: number) => {
    for (let n = a; n <= b; n++) {
      const m = re.exec(ix.text(n).trim())
      if (m) return m[1]!.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0)
    }
    return null
  }
  // Bambu files carry it in the header; Orca's own config block is at the end.
  return scan(1, Math.min(ix.count, HEADER_LINES)) ?? scan(Math.max(1, ix.count - TAIL_LINES), ix.count)
}

/** The last line before the first move whose extrusion mode counts: the start G-code. */
function startEnd(count: number, firstMoveLine: number): number {
  return firstMoveLine > 0 ? firstMoveLine - 1 : Math.min(count, START_LINES - 1)
}

/** The extrusion mode the start G-code leaves: true for M83 (relative), the Bambu default. */
function relativeAtStart(ix: Lines, firstMoveLine: number): boolean {
  let rel = true
  const stop = startEnd(ix.count, firstMoveLine)
  for (let n = 1; n <= stop; n++) {
    const t = ix.text(n).trimStart()
    if (t.startsWith('M82') && !/^M82\d/.test(t)) rel = false
    else if (t.startsWith('M83') && !/^M83\d/.test(t)) rel = true
  }
  return rel
}

function* linesBetween(ix: Lines, a: number, b: number): Generator<string> {
  for (let n = a; n <= b; n++) yield ix.text(n)
}

const TOOL = /^\s*T(\d+)\b/

/** The first line of each run of lines after a `T` that picks another tool, from `line(n)` for n in 1..count. */
function toolRunStarts(): { starts: number[]; see(n: number, text: string): void } {
  const starts: number[] = []
  let tool = -1
  return {
    starts,
    see(n, text) {
      const m = TOOL.exec(text)
      if (!m) return
      const t = Number(m[1])
      if (t > 255) return
      if (tool >= 0 && t !== tool) starts.push(n)
      tool = t
    },
  }
}

/** Whether the preview's moves carry their G-code lines. */
const lined = (p: PreviewBuffers) => p.extrasOffset >= 0 && lineOfSegment(p, p.segmentCount - 1) > 0

/** The line range of each change's flush: from the moves' lines, or the tool command groups when there are none. */
function changeRanges(count: number, p: PreviewBuffers, tl: Timeline, toolStarts: number[] | null): [number, number][] {
  if (lined(p)) return tl.changes.map((c) => [lineOfSegment(p, c.segment - 1) + 1, lineOfSegment(p, c.segment) - 1])
  const starts = toolStarts ?? []
  const groups = starts.map((a, i): [number, number] => [a, (starts[i + 1] ?? count + 1) - 1])
  return tl.changes.map((_, i) => groups[groups.length - tl.changes.length + i] ?? [1, 0])
}

/**
 * The flush lines of each change: between the last move before it and its first move, by the G-code lines
 * the preview's moves carry. A preview without line numbers is split at the tool commands instead, and the
 * last groups are matched to the changes.
 */
function changeLines(ix: Lines, p: PreviewBuffers, tl: Timeline, toolStarts: number[] | null): (() => Iterable<string>)[] {
  let starts = toolStarts
  if (!lined(p) && !starts) {
    const runs = toolRunStarts()
    for (let n = 1; n <= ix.count; n++) runs.see(n, ix.text(n))
    starts = runs.starts
  }
  return changeRanges(ix.count, p, tl, starts).map(([a, b]) => () => (b >= a ? linesBetween(ix, a, b) : []))
}

/**
 * The lines the purges read, fetched from `src` a window at a time: the header, the tail, the start G-code and
 * each change's flush. Without line numbers the tool commands are found by a scan of the whole text, a window at a
 * time, none of it kept.
 */
export async function purgeLines(src: LineSource, p: PreviewBuffers, tl: Timeline): Promise<{ lines: Lines; toolStarts: number[] | null }> {
  let toolStarts: number[] | null = null
  if (!lined(p)) {
    const runs = toolRunStarts()
    for await (const [w, a, b] of windows(src, 200_000)) for (let n = a; n <= b; n++) runs.see(n, lineText(w, n))
    toolStarts = runs.starts
  }
  const ranges: [number, number][] = [
    [1, Math.max(Math.min(src.count, HEADER_LINES), startEnd(src.count, lineOfSegment(p, 0)))],
    [Math.max(1, src.count - TAIL_LINES), src.count],
    ...changeRanges(src.count, p, tl, toolStarts).filter(([a, b]) => b >= a),
  ]
  // Neighbours are read together, in fewer calls to the host.
  ranges.sort((x, y) => x[0] - y[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1] + 200) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const wins = await Promise.all(merged.map(([a, b]) => src.window(a, b)))
  return { lines: windowLines(src.count, wins), toolStarts }
}

/**
 * The purge of every change of `tl` from the G-code `text` (the whole text, or the lines purgeLines read, with the
 * tool command lines it found). Changes without a flush get none.
 */
export function plansFromText(text: LineIndex | Lines, p: PreviewBuffers, tl: Timeline, spec: ToolChangerSpec, toolStarts: number[] | null = null): PlayPurge[] {
  if (!spec.chute || !tl.changes.length) return []
  const ix = linesOf(text)
  const density = headerList(ix, 'filament_density') ?? []
  const diameter = headerList(ix, 'filament_diameter') ?? []
  const rel = relativeAtStart(ix, lineOfSegment(p, 0))
  const groups = changeLines(ix, p, tl, toolStarts)
  const view = new DataView(p.raw, p.segmentsOffset, p.segmentCount * SXPV_SEGMENT_BYTES)
  const seg = new Float32Array(p.raw, p.segmentsOffset, p.segmentCount * (SXPV_SEGMENT_BYTES / 4))
  const first = view.getUint8(SXPV_SEGMENT.tool)
  const fromTools = purgeFromTools(spec, first, tl.changes)
  const out: PlayPurge[] = []
  let before = 0
  const history: [number, number][] = []
  tl.changes.forEach((c, i) => {
    const flush = flushOf(groups[i]!(), rel)
    const hist = history.slice()
    history.push([c.from, c.to])
    if (!flush) return
    const q = (c.segment - 1) * 8
    const r = c.segment * 8
    const at: [number, number, number] = [seg[q + 2] ?? 0, seg[q + 3] ?? 0, seg[q + 4] ?? 0]
    const resume: [number, number, number] = [seg[r] ?? 0, seg[r + 1] ?? 0, seg[r + 4] ?? 0]
    const seq = changeSequence(spec, c.from, c.to, at, resume, c.fixed, hist, printedTop(p, c.segment))
    const window = purgeWindow(seq, flush.seconds)
    if (!window) return
    const volume = purgeVolume(flush.e, diameter[c.to] ?? diameter[0] ?? 1.75)
    // The flush is the new filament pushing the old one out: weighed at the new filament's density.
    const grams = purgeGrams(volume, density[c.to] ?? density[0] ?? 1.24)
    out.push({ segment: c.segment, e: flush.e, volume, grams, steps: flush.steps, from: fromTools[i] ?? c.from, to: c.to, window, before })
    before += grams
  })
  return out
}

/** Loads the purges for what Preview shows, once per preview. Resolves to the plans, empty when there are none. */
export async function loadPurges(host: Host, p: PreviewBuffers, tl: Timeline, spec: ToolChangerSpec | null): Promise<PlayPurge[]> {
  const s = purgeView.getState()
  if (s.timeline === tl) return s.plans
  purgeView.setState({ timeline: tl, plans: [] })
  if (!spec?.chute || !tl.changes.length) return []
  const hold = holdText(host)
  if (!hold.source) return []
  try {
    const { lines, toolStarts } = await purgeLines(await hold.source, p, tl)
    if (purgeView.getState().timeline !== tl) return []
    const plans = plansFromText(lines, p, tl, spec, toolStarts)
    purgeView.setState({ timeline: tl, plans })
    return plans
  } catch {
    return []
  } finally {
    hold.release()
  }
}

