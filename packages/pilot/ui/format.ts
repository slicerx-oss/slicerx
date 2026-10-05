// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keep this file free of DOM and CSS imports: the phone app imports it.
// Small formatters shared by the mimir chat components. Pure, no DOM.
import type { Tone } from '@slicerx/contracts'

/** 42s, 1m 12s. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** 812, 2.4k. */
export function fmtTokens(n: number): string {
  return n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1)}k`
}

/** Seconds with one decimal, as on a tool row: 0.8s. */
export function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** 24 hour local clock, 14:03. */
export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 4:59 for a countdown. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Today 14:02", "Yesterday 19:20", "Sep 27 16:05", as in the sessions rail. */
export function fmtWhen(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = new Date(t)
  day.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  const hm = fmtClock(t)
  if (diff === 0) return `Today ${hm}`
  if (diff === 1) return `Yesterday ${hm}`
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()} ${hm}`
}

export interface TextSeg {
  text: string
  kind: 'plain' | 'code' | 'bold'
}

/** Splits prose into plain text, `code` spans and **bold** runs, as the chat renders them. */
export function segs(text: string): TextSeg[] {
  const out: TextSeg[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), kind: 'plain' })
    const code = m[1]
    out.push(code !== undefined ? { text: code, kind: 'code' } : { text: m[2] ?? '', kind: 'bold' })
    last = re.lastIndex
  }
  if (last < text.length) {
    // A marker whose closing half has not streamed in yet opens its span now,
    // so the reader never sees raw ** or backticks mid-stream.
    const tail = text.slice(last)
    const open = tail.search(/\*\*|`/)
    if (open < 0) out.push({ text: tail, kind: 'plain' })
    else {
      if (open > 0) out.push({ text: tail.slice(0, open), kind: 'plain' })
      const code = tail[open] === '`'
      const rest = tail.slice(open + (code ? 1 : 2)).replace(/\*+$/, '')
      if (rest) out.push({ text: rest, kind: code ? 'code' : 'bold' })
    }
  }
  return out
}

export interface ArgToken {
  text: string
  kind: 'str' | 'flag' | 'value'
}

/** Tokenizes a tool's argument line for the `$ source tool args` command line. */
export function argTokens(args: string): ArgToken[] {
  return (args.match(/"[^"]*"|\S+/g) ?? []).map((x) => ({
    text: x,
    kind: x.startsWith('"') ? 'str' : x.startsWith('--') ? 'flag' : 'value',
  }))
}

/** Class for a tone in tool output. */
export function toneClass(tone: Tone | undefined): string {
  return tone ? `c-${tone}` : ''
}

export const BAR_WIDTH = 22

/** Filled and empty cell counts for a text progress bar. */
export function barCells(fraction: number): { filled: number; empty: number } {
  const f = Math.round(Math.min(1, Math.max(0, fraction)) * BAR_WIDTH)
  return { filled: f, empty: BAR_WIDTH - f }
}
