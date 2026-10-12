// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fleets are the user's own groups of printers. Editing them changes no printer, so they need no approval; each edit
// is logged under its own name.
import { hashParams } from '@slicerx/contracts'
import { z } from 'zod'
import type { ServerToolDeps } from './deps'

export const fleetId = z.string().min(1).describe('Fleet id from slicerx_list_fleets')
export const printerIdArg = z.string().min(1).describe('Printer id from slicerx_printer_list')
export const editHints = { readOnly: false, destructive: false, idempotent: false, openWorld: false }

/** Runs a fleet edit, logs it, and answers with its result. */
export async function fleetEdit<T>(d: ServerToolDeps, tool: string, args: unknown, run: () => Promise<T>): Promise<{ summary: string; structured: Record<string, unknown> }> {
  const result = await run()
  d.gate.log.append({ tool, permission: 'fleet', decision: 'allowed', input_hash: await hashParams(args), ok: true })
  return { summary: tool, structured: { result } }
}
