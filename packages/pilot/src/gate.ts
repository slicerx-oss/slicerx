// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Permission gate. Pure policy lookup; the runtime turns an `ask` into an
// approval card and a token, and nothing here can mint one.
import type { ApprovalRequest, PermissionClass, PermissionMode, PermissionPolicy } from '@slicerx/contracts'
import { DEFAULT_POLICY } from '@slicerx/contracts'

/** Classes that reach a printer. A policy can set them to ask or off, never allow: a person approves each one. */
const PRINTER_CLASSES = ['queue', 'start'] as const
const forPrinter = (c: PermissionClass): c is (typeof PRINTER_CLASSES)[number] => c === 'queue' || c === 'start'

/** Actions that start a print. No policy grants them, whatever class the tool that asks for them has. */
const PRINT_STARTS = new Set(['printer.start', 'printer.resume'])

/** Whether an approval card would start or resume a print. */
export function startsPrint(req: Pick<ApprovalRequest, 'actions'>): boolean {
  return req.actions.some((a) => PRINT_STARTS.has(a.action))
}

export function decide(policy: PermissionPolicy, permission: PermissionClass, printerId?: string): PermissionMode {
  if (permission === 'read') return 'allow'
  let mode = policy.classes[permission] ?? 'ask'
  if (printerId && forPrinter(permission)) {
    const per = policy.printers?.[printerId]?.[permission]
    // A per-printer setting can turn a printer off, but a class set to off stays off.
    if (per && mode !== 'off') mode = per
  }
  if (forPrinter(permission) && mode === 'allow') mode = 'ask'
  return mode
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
  for (const k of PRINTER_CLASSES) if (out.classes[k] === 'allow') out.classes[k] = 'ask'
  if (raw.printers && typeof raw.printers === 'object') {
    const printers: NonNullable<PermissionPolicy['printers']> = {}
    for (const [id, p] of Object.entries(raw.printers)) {
      if (typeof p !== 'object' || p === null) continue
      const entry: Partial<Record<'queue' | 'start', PermissionMode>> = {}
      for (const k of PRINTER_CLASSES) {
        const v = p[k]
        if (typeof v === 'string' && MODES.has(v as PermissionMode)) entry[k] = v === 'allow' ? 'ask' : (v as PermissionMode)
      }
      printers[id] = entry
    }
    out.printers = printers
  }
  return out
}
