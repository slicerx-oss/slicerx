// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The purge of each tool change at the chute, read from the slice's G-code: the flush the change G-code
// extrudes (or hands the firmware), its volume and weight, and when it plays inside the change. Loaded on
// first use (it reads the G-code text); the viewport draws the blob from the plans and the playback bar
// reads out the grams (purge-view.ts).
import { SXPV_SEGMENT, SXPV_SEGMENT_BYTES, type Host, type PreviewBuffers } from '@slicerx/contracts'
import { changeSequence, flushOf, printedTop, purgeFromTools, purgeGrams, purgeVolume, purgeWindow, type ToolChangerSpec } from '@slicerx/viewport'
import type { Timeline } from '../../lib/preview-timeline'
import { lineOfSegment, lineText, type LineIndex } from './gcode-lines'
import { currentText } from './gcode-source'
import { purgeView, type PlayPurge } from './purge-view'

/** Per filament numbers from a G-code comment such as `; filament_density: 1.24,1.26` or `; filament_diameter = 1.75`. */
function headerList(ix: LineIndex, key: string): number[] | null {
  const re = new RegExp(`^;\\s*${key}\\s*[:=]\\s*([\\d.,\\s]+)$`)
  const scan = (a: number, b: number) => {
    for (let n = a; n <= b; n++) {
      const m = re.exec(lineText(ix, n).trim())
      if (m) return m[1]!.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0)
    }
    return null
  }
  // Bambu files carry it in the header; Orca's own config block is at the end.
  return scan(1, Math.min(ix.count, 400)) ?? scan(Math.max(1, ix.count - 3000), ix.count)
}

/** The extrusion mode the start G-code leaves: true for M83 (relative), the Bambu default. */
function relativeAtStart(ix: LineIndex, firstMoveLine: number): boolean {
  let rel = true
  const stop = firstMoveLine > 0 ? firstMoveLine : Math.min(ix.count, 5000)
  for (let n = 1; n < stop; n++) {
    const t = lineText(ix, n).trimStart()
    if (t.startsWith('M82') && !/^M82\d/.test(t)) rel = false
    else if (t.startsWith('M83') && !/^M83\d/.test(t)) rel = true
  }
  return rel
}

function* linesBetween(ix: LineIndex, a: number, b: number): Generator<string> {
  for (let n = a; n <= b; n++) yield lineText(ix, n)
}

/**
 * The flush lines of each change: between the last move before it and its first move, by the G-code lines
 * the preview's moves carry. A preview without line numbers is split at the tool commands instead, and the
 * last groups are matched to the changes.
 */
function changeLines(ix: LineIndex, p: PreviewBuffers, tl: Timeline): (() => Iterable<string>)[] {
  const lined = p.extrasOffset >= 0 && lineOfSegment(p, p.segmentCount - 1) > 0
  if (lined) {
    return tl.changes.map((c) => {
      const a = lineOfSegment(p, c.segment - 1) + 1
      const b = lineOfSegment(p, c.segment) - 1
      return () => (b >= a ? linesBetween(ix, a, b) : [])
    })
  }
  const starts: number[] = []
  let tool = -1
  for (let n = 1; n <= ix.count; n++) {
    const m = /^\s*T(\d+)\b/.exec(lineText(ix, n))
    if (!m) continue
    const t = Number(m[1])
    if (t > 255) continue
    if (tool >= 0 && t !== tool) starts.push(n)
    tool = t
  }
  const groups = starts.map((a, i) => () => linesBetween(ix, a, (starts[i + 1] ?? ix.count + 1) - 1))
  return tl.changes.map((_, i) => groups[groups.length - tl.changes.length + i] ?? (() => []))
}

/** The purge of every change of `tl` from the G-code `ix`. Changes without a flush get none. */
export function plansFromText(ix: LineIndex, p: PreviewBuffers, tl: Timeline, spec: ToolChangerSpec): PlayPurge[] {
  if (!spec.chute || !tl.changes.length) return []
  const density = headerList(ix, 'filament_density') ?? []
  const diameter = headerList(ix, 'filament_diameter') ?? []
  const rel = relativeAtStart(ix, lineOfSegment(p, 0))
  const groups = changeLines(ix, p, tl)
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
  const text = currentText(host)
  if (!text) return []
  try {
    const ix = await text
    if (purgeView.getState().timeline !== tl) return []
    const plans = plansFromText(ix, p, tl, spec)
    purgeView.setState({ timeline: tl, plans })
    return plans
  } catch {
    return []
  }
}

