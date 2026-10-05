// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Permission gate. Pure policy lookup; the runtime turns an `ask` into an
// approval card and a token, and nothing here can mint one.
import type { PermissionClass, PermissionMode, PermissionPolicy } from '@slicerx/contracts'
import { DEFAULT_POLICY } from '@slicerx/contracts'

export function decide(policy: PermissionPolicy, permission: PermissionClass, printerId?: string): PermissionMode {
  if (permission === 'read') return 'allow'
  let mode = policy.classes[permission] ?? 'ask'
  // `start: allow` is only honored per printer, confirmed in the UI.
  if (permission === 'start' && mode === 'allow') mode = 'ask'
  if (printerId && (permission === 'queue' || permission === 'start')) {
    const per = policy.printers?.[printerId]?.[permission]
    // A per-printer setting can loosen ask to allow, but a class set to off stays off.
    if (per && mode !== 'off') mode = per
  }
  return mode ?? 'ask'
}

const MODES = new Set<PermissionMode>(['allow', 'ask', 'off'])

/** Accepts a policy from config or the UI, falling back to the defaults for anything malformed. */
export function normalizePolicy(input: unknown): PermissionPolicy {
  const out: PermissionPolicy = { classes: { ...DEFAULT_POLICY.classes } }
  if (typeof input !== 'object' || input === null) return out
  const raw = input as { classes?: Record<string, unknown>; printers?: Record<string, Record<string, unknown>> }
  for (const k of Object.keys(DEFAULT_POLICY.classes) as (keyof PermissionPolicy['classes'])[]) {
    const v = raw.classes?.[k]
    if (typeof v === 'string' && MODES.has(v as PermissionMode)) out.classes[k] = v as PermissionMode
  }
  if (out.classes.start === 'allow') out.classes.start = 'ask'
  if (raw.printers && typeof raw.printers === 'object') {
    const printers: NonNullable<PermissionPolicy['printers']> = {}
    for (const [id, p] of Object.entries(raw.printers)) {
      if (typeof p !== 'object' || p === null) continue
      const entry: Partial<Record<'queue' | 'start', PermissionMode>> = {}
      for (const k of ['queue', 'start'] as const) {
        const v = p[k]
        if (typeof v === 'string' && MODES.has(v as PermissionMode)) entry[k] = v as PermissionMode
      }
      printers[id] = entry
    }
    out.printers = printers
  }
  return out
}
