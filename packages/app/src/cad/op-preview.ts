// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The operation preview's state, shared by every Model tool that previews in the view (push and pull, fillet and
// chamfer). A tool asks for a preview, gets one or an error, and the view draws what the state holds: when an edit
// fails (a value that does not read, an engine error), the last good preview stays on screen and the error shows next
// to the tool, instead of the preview vanishing. The view's look is the same for all of them (viewport OpPreviewLook:
// added material tinted, removed material a ghost). The open tool's state is published here for the app link.
import { useReducer, useSyncExternalStore } from 'react'
import { sentence } from './tool-panel'

export type PreviewStatus = 'none' | 'pending' | 'ok' | 'error'

/** A tool's preview: what the view shows (`shown`) and how the last edit went. */
export interface OpPreview<T> {
  status: PreviewStatus
  /** What the view draws: the newest good preview, kept through an error. Null draws nothing. */
  shown: T | null
  /** The last edit's problem while `status` is `error`. */
  error: string | null
  /** `shown` is from an earlier edit than the one in the fields (an error or a newer request is pending). */
  stale: boolean
}

export type OpPreviewEvent<T> =
  /** Nothing to preview: no face or edge picked, or no value typed. Drops the kept preview. */
  | { type: 'clear' }
  /** A new edit asked the engine for its preview; the one shown stays until the answer. */
  | { type: 'request' }
  | { type: 'ok'; value: T }
  /** The edit failed: the last good preview stays, with the error. */
  | { type: 'fail'; message: string }

export const NO_PREVIEW: OpPreview<never> = { status: 'none', shown: null, error: null, stale: false }

export function stepPreview<T>(s: OpPreview<T>, e: OpPreviewEvent<T>): OpPreview<T> {
  switch (e.type) {
    case 'clear':
      return s.status === 'none' && s.shown === null ? s : NO_PREVIEW
    case 'request':
      return s.status === 'pending' ? s : { status: 'pending', shown: s.shown, error: s.error, stale: s.shown !== null }
    case 'ok':
      return s.status === 'ok' && s.shown === e.value ? s : { status: 'ok', shown: e.value, error: null, stale: false }
    case 'fail':
      return s.status === 'error' && s.error === e.message ? s : { status: 'error', shown: s.shown, error: e.message, stale: s.shown !== null }
  }
}

/** The words next to the tool for a failed edit, saying the view keeps the last good preview when it does. */
export function previewMessage(p: OpPreview<unknown>): string | null {
  if (p.status !== 'error' || !p.error) return null
  return p.shown !== null ? `${p.error} Showing the last good preview.` : p.error
}

const SIZE_NAMES: Record<string, string> = {
  radiusMm: 'Radius',
  distanceMm: 'Distance',
  distance2Mm: 'The other distance',
  wallMm: 'Wall',
  diameterMm: 'Diameter',
  depthMm: 'Depth',
  heightMm: 'Height',
  widthMm: 'Width',
  sizeMm: 'Size',
}

const nameOf = (key: string): string | undefined => SIZE_NAMES[key.charAt(0).toLowerCase() + key.slice(1)]
/** "Radius" reads "The radius" at the start of a sentence; "The other distance" keeps its own article. */
const theName = (name: string) => (name.startsWith('The ') ? name : `The ${name.toLowerCase()}`)
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const whole = (v: number) => String(v)

/**
 * An engine's size error in the person's words: the field's name instead of its key, and plain numbers
 * ("radiusMm: 30 mm does not fit on this face; at most 20.000 mm" reads "Radius 30 mm does not fit on this face; at most 20 mm.").
 * The engine's range check ("distanceMm: must not be zero (at most 10000 mm)") says what is wrong with `value`, the
 * number the person gave, when it is passed: too large, or 0. A key the list does not name is dropped, never shown,
 * and a request the engine could not read (an empty box sends no number) asks for a number.
 */
export function sizeWords(message: string, value?: number): string {
  const range = /^\s*(\w+Mm):\s*must (be above 0|not be zero) \(at most (\d+(?:\.\d+)?) mm\)\.?\s*$/.exec(message)
  const rangeName = range ? nameOf(range[1]!) : undefined
  if (range && rangeName) {
    const the = theName(rangeName)
    const most = Number(range[3])
    const v = value !== undefined && Number.isFinite(value) ? value : null
    if (v !== null && Math.abs(v) > most) return `${the} is too large. The most is ${whole(most)} mm.`
    if (range[2] === 'not be zero') return v === 0 ? `${the} can't be 0 mm.` : `${the} must be between -${whole(most)} and ${whole(most)} mm, and not 0.`
    return v !== null && v <= 0 ? `${the} must be more than 0 mm.` : `${the} must be more than 0 mm and at most ${whole(most)} mm.`
  }
  if (/invalid type: null|expected f64|missing field/.test(message)) return 'Type a number in every box.'
  // "radiusMm: 30 mm ..." names the field; "wallMm: must be above 0" says the field must; any other words stand alone
  const named = message.replace(/^\s*(\w+Mm):\s*(\S*)/, (_all, key: string, next: string) => {
    const name = nameOf(key)
    if (name && /^\d/.test(next)) return `${name} ${next}`
    if (name && next === 'must') return `${theName(name)} must`
    return next
  }).replace(/must be above 0(?! ?mm)/, 'must be more than 0 mm')
  const plain = upper(named.trim()).replace(/(\d+\.\d+)(?= ?mm)/g, (n) => String(Math.round(Number(n) * 100) / 100))
  return /[.!?]$/.test(plain) ? plain : `${plain}.`
}

/**
 * An apply or preview error for a tool's panel, in plain words (sizeWords). `typed` holds what the person typed by the
 * engine's field key ({ radiusMm: 100000 }), so a size past the engine's limit reads "is too large" with the most.
 */
export function toolError(err: unknown, typed: Readonly<Record<string, number | null | undefined>> = {}): string {
  const m = sentence(err instanceof Error ? err.message : String(err))
  const key = /^\s*(\w+Mm):/.exec(m)?.[1]
  const v = key ? typed[key.charAt(0).toLowerCase() + key.slice(1)] : undefined
  return sizeWords(m, v ?? undefined)
}

/** A tool's preview state, for React. */
export function useOpPreview<T>(): [OpPreview<T>, (e: OpPreviewEvent<T>) => void] {
  return useReducer(stepPreview<T>, NO_PREVIEW as OpPreview<T>)
}

// ---------- the open tool's preview, for the app link ----------

export type PreviewTool = 'push' | 'fillet' | 'chamfer'

/** The open tool's preview as clients read it back (model.preview). */
export interface PreviewReport {
  tool: PreviewTool
  status: PreviewStatus
  /** The error next to the tool, as the person reads it. */
  message: string | null
  /** The view shows a preview from an earlier edit, kept through an error. */
  showingLastGood: boolean
  /** What the shown preview does: adds material (tinted), removes it (a ghost), or both (a fillet on mixed edges). */
  adds: boolean
  removes: boolean
}

let report: PreviewReport | null = null
const listeners = new Set<() => void>()

/** The tool publishes its preview each time it changes; null when it closes. */
export function publishPreview(r: PreviewReport | null): void {
  if (r === report || (r && report && JSON.stringify(r) === JSON.stringify(report))) return
  report = r
  for (const fn of listeners) fn()
}

/** The open tool's preview, or null when no previewing tool is open. */
export function previewReport(): PreviewReport | null {
  return report
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export function usePreviewReport(): PreviewReport | null {
  return useSyncExternalStore(subscribe, previewReport, previewReport)
}

/** A tool's report from its state. */
export function reportOf(tool: PreviewTool, p: OpPreview<unknown>, shows: { adds: boolean; removes: boolean }): PreviewReport {
  const on = p.shown !== null
  return { tool, status: p.status, message: previewMessage(p), showingLastGood: on && p.stale, adds: on && shows.adds, removes: on && shows.removes }
}
