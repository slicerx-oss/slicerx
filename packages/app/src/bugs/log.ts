// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The recent app log that bug reports attach: what went to the console and the app's own notes (start,
// workspace, slicing, crashes), kept in memory as the last few hundred lines. The app itself hardly writes to
// the console, so without the notes a report usually had no log at all. A copy of the tail is saved now and
// then and when the page goes away, so a report about a window that crashed or reloaded can carry the log of
// the session that ended. Lines are scrubbed when a report is made, not here.

const MAX_LINES = 600
const MAX_LINE = 2000
const SAVED_KEY = 'slicerx.bugs.lastlog.v1'
const SAVED_CHARS = 48_000
/** The note written when the page goes away on its own terms (a reload, a navigation, closing). */
export const UNLOAD_NOTE = 'The page is unloading.'

const lines: string[] = []
let started = false
let previous: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function text(v: unknown): string {
  if (v instanceof Error) return v.stack && v.stack.includes(v.message) ? v.stack : `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

function stamp(d = new Date()): string {
  return d.toISOString().slice(11, 23)
}

/** Adds one line to the log, as the console wrappers do. */
export function logLine(level: string, args: readonly unknown[]): void {
  let line = `${stamp()} ${level.padEnd(5)} ${args.map(text).join(' ')}`
  if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)} [cut]`
  lines.push(line)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  saveSoon()
}

/** Adds one of the app's own lines to the log, without writing it to the console. */
export function note(text: string): void {
  logLine('note', [text])
}

function saveNow(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  try {
    localStorage.setItem(SAVED_KEY, logTail(SAVED_CHARS))
  } catch {
    // Storage full or blocked: the in-memory log still works.
  }
}

function saveSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(saveNow, 2000)
}

/** Starts copying console output into the log. Safe to call more than once. */
export function startLogCapture(): void {
  if (started) return
  started = true
  try {
    previous = localStorage.getItem(SAVED_KEY)
  } catch {
    previous = null
  }
  for (const level of ['debug', 'log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      try {
        logLine(level, args)
      } catch {
        // Never let logging break the caller.
      }
      original(...args)
    }
  }
  // A reload or a navigation lets the page say so and save at once; a crash does not, which is how the
  // next start tells them apart.
  window.addEventListener('pagehide', () => {
    note(UNLOAD_NOTE)
    saveNow()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow()
  })
}

/** The last lines of the log, at most `maxChars`, starting on a whole line. */
export function logTail(maxChars = 64_000): string {
  const all = lines.join('\n')
  if (all.length <= maxChars) return all
  const cut = all.slice(all.length - maxChars)
  const nl = cut.indexOf('\n')
  return nl >= 0 ? cut.slice(nl + 1) : cut
}

/** The tail saved by the previous session, read once at start; null when there was none. */
export function previousLogTail(): string | null {
  return previous
}

/** True when the saved log of the previous page ends with the page unloading on its own terms. */
export function unloadedCleanly(saved: string | null): boolean {
  const last = saved?.trimEnd().split('\n').pop() ?? ''
  return last.endsWith(` note  ${UNLOAD_NOTE}`)
}

/** For tests. */
export function resetLog(): void {
  lines.length = 0
}
