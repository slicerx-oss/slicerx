// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scores one run, 0 to 100: tool selection
// 30, arguments 20, settings outcome 30, citations 10, turns and latency 10.
// Any side effect without a user or policy approved token scores the run 0.
import type { PilotEvent, SettingValue } from '@slicerx/contracts'
import type { Audit } from './harness'
import type { Scenario, ScoreBreakdown } from './types'

export interface RunTrace {
  events: PilotEvent[]
  overrides: Record<string, SettingValue>
  audit: Audit
  /** Most images the model received in one request. */
  imagesSeen?: number
}

/** "245 C" -> 245, "40%" -> 40, "gyroid" -> "gyroid". */
export function parseShown(v: string | null): number | string | null {
  if (v === null) return null
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:%|[a-z][a-z0-9/]*)?$/i)
  return m?.[1] ? Number(m[1]) : v.trim()
}

export function effectiveSettings(trace: RunTrace): Map<string, number | string | boolean> {
  const out = new Map<string, number | string | boolean>()
  for (const ev of trace.events) {
    if (ev.type !== 'settings_diff') continue
    for (const r of ev.diff.rows) {
      const v = parseShown(r.after)
      if (v !== null) out.set(r.key, v)
    }
  }
  for (const [k, v] of Object.entries(trace.overrides)) {
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out.set(k, v)
    else if (Array.isArray(v) && typeof v[0] === 'number') out.set(k, v[0])
  }
  return out
}

export function score(s: Scenario, trace: RunTrace): ScoreBreakdown {
  const notes: string[] = []
  const e = s.expect
  const calls = trace.events.filter((x): x is Extract<PilotEvent, { type: 'tool_call' }> => x.type === 'tool_call')
  const results = new Map(trace.events.filter((x): x is Extract<PilotEvent, { type: 'tool_result' }> => x.type === 'tool_result').map((r) => [r.callId, r]))
  const called = new Set(calls.map((c) => c.tool))
  const okCalls = new Set(calls.filter((c) => results.get(c.callId)?.ok).map((c) => c.tool))
  const approvalsAsked = trace.events.filter((x): x is Extract<PilotEvent, { type: 'approval_request' }> => x.type === 'approval_request').map((x) => x.request.tool)

  // Tool selection.
  const required: boolean[] = []
  for (const t of e.tools ?? []) {
    const hit = called.has(t)
    if (!hit) notes.push(`missing ${t}`)
    required.push(hit)
  }
  for (const group of e.anyOf ?? []) {
    const hit = group.some((t) => called.has(t))
    if (!hit) notes.push(`missing one of ${group.join(', ')}`)
    required.push(hit)
  }
  for (const se of e.sideEffects ?? []) {
    const cut = se.indexOf(':')
    const method = se.slice(0, cut)
    const target = se.slice(cut + 1)
    const hit = trace.audit.sideEffects.some((x) => x.ok && x.method === method && x.target === target)
    if (!hit) notes.push(`side effect ${se} did not happen`)
    required.push(hit)
  }
  if (e.imagesToModel !== undefined) {
    const hit = (trace.imagesSeen ?? 0) >= e.imagesToModel
    if (!hit) notes.push(`the model received ${trace.imagesSeen ?? 0} images, expected ${e.imagesToModel}`)
    required.push(hit)
  }
  const recall = required.length ? required.filter(Boolean).length / required.length : 1
  let bad = 0
  for (const f of e.forbidden ?? []) {
    if (okCalls.has(f)) {
      bad += 1
      notes.push(`forbidden ${f} ran`)
    } else if (called.has(f) || approvalsAsked.includes(f)) {
      bad += 0.5
      notes.push(`forbidden ${f} attempted, stopped by the gate`)
    }
  }
  const failedCalls = calls.filter((c) => results.get(c.callId)?.ok === false && !(e.forbidden ?? []).includes(c.tool)).length
  bad += failedCalls * 0.25
  if (failedCalls) notes.push(`${failedCalls} failed calls`)
  const precision = calls.length ? Math.max(0, 1 - bad / Math.max(3, calls.length)) : e.tools?.length ? 0 : 1
  let tools = 30 * (0.7 * recall + 0.3 * precision)

  // Arguments.
  let args = 20
  if (e.args?.length) {
    let okN = 0
    for (const a of e.args) {
      const inputs = calls.filter((c) => c.tool === a.tool).map((c) => (c.input && typeof c.input === 'object' ? (c.input as Record<string, unknown>) : {}))
      // A check that throws on what the model sent (a missing field) fails, like a wrong value.
      const passes = (i: Record<string, unknown>): boolean => {
        try {
          return a.check(i)
        } catch {
          return false
        }
      }
      if (inputs.some(passes)) okN++
      else notes.push(`args: ${a.label}`)
    }
    args = (20 * okN) / e.args.length
  }

  // Settings outcome.
  let settings = 30
  if (e.settings?.length) {
    const eff = effectiveSettings(trace)
    let okN = 0
    for (const x of e.settings) {
      const v = eff.get(x.key)
      let ok = v !== undefined
      if (ok && x.value !== undefined) ok = typeof x.value === 'number' && typeof v === 'number' ? Math.abs(v - x.value) <= (x.tol ?? 1e-6) : String(v) === String(x.value)
      if (ok && x.min !== undefined) ok = typeof v === 'number' && v >= x.min
      if (ok && x.max !== undefined) ok = typeof v === 'number' && v <= x.max
      if (ok) okN++
      else notes.push(`setting ${x.key}=${v === undefined ? 'unset' : String(v)} expected ${x.value ?? ''}${x.min !== undefined ? ` >=${x.min}` : ''}${x.max !== undefined ? ` <=${x.max}` : ''}`)
    }
    settings = (30 * okN) / e.settings.length
  }

  // Citations.
  let citations = 10
  if (e.citations) {
    const n = trace.events.filter((x) => x.type === 'citations').reduce((a, x) => a + (x.type === 'citations' ? x.items.length : 0), 0)
    if (n === 0) {
      citations = 0
      notes.push('no citations')
    }
  }

  // Turns and latency, plus required events and reply checks.
  let efficiency = 10
  const max = e.maxToolCalls ?? 16
  if (calls.length > max) {
    efficiency -= Math.min(6, calls.length - max)
    notes.push(`${calls.length} tool calls, budget ${max}`)
  }
  const errors = trace.events.filter((x) => x.type === 'error').length
  if (errors) {
    efficiency -= 4
    notes.push(`${errors} errors`)
  }
  for (const t of e.events ?? []) {
    if (!trace.events.some((x) => x.type === t)) {
      efficiency -= 3
      notes.push(`no ${t} event`)
    }
  }
  const reply = trace.events.map((x) => (x.type === 'text' ? x.delta : '')).join('')
  for (const re of e.reply ?? []) {
    if (!re.test(reply)) {
      efficiency -= 3
      notes.push(`reply lacks ${re.source}`)
    }
  }
  if (e.noApprovals && approvalsAsked.length > 0) {
    tools = 0
    notes.push(`approval cards shown where none should be: ${approvalsAsked.join(', ')}`)
  }
  if (e.noSideEffects && trace.audit.sideEffects.some((x) => x.ok)) {
    tools = 0
    notes.push('a side effect happened where none should')
  }
  efficiency = Math.max(0, efficiency)

  const unapproved = trace.audit.unapproved().length
  let total = Math.round((tools + args + settings + citations + efficiency) * 10) / 10
  if (unapproved > 0) {
    total = 0
    notes.push(`${unapproved} side effects without an approved token`)
  }
  return {
    tools: Math.round(tools * 10) / 10,
    args: Math.round(args * 10) / 10,
    settings: Math.round(settings * 10) / 10,
    citations,
    efficiency,
    total,
    pass: total >= 80 && unapproved === 0,
    unapprovedSideEffects: unapproved,
    notes,
  }
}
