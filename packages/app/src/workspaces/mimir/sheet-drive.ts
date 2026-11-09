// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A confirmed sheet drives its design: editing a bound row after the build edits the step it set, through the design
// tool a client calls (design.edit_step), so the history replays as a person's edit would. A row that shapes a sketch
// rather than one number is not bound; editing it asks mimir to build again.
import { assistantText } from '@slicerx/contracts'
import type { PilotSheetBind } from '@slicerx/contracts'
import { plainEngine, type PilotTool } from '@slicerx/pilot'

/** `detail`: the engine's own words when `summary` says its refusal plainly, for the dev log only. */
export type RowEdit = { ok: true; summary: string } | { ok: false; reason: 'unbound' | 'refused'; summary: string; detail?: string }

/** A refused edit in plain words: an engine refusal reads as its plain line, with the engine's text kept aside. */
function refused(text: string): RowEdit {
  const plain = plainEngine(text, 'design.edit_step')
  return plain ? { ok: false, reason: 'refused', summary: plain.shown, detail: plain.raw } : { ok: false, reason: 'refused', summary: text }
}

/** The step number a bound row sets for `value`. */
export const stepValue = (b: PilotSheetBind, value: number): number => Math.round((value * (b.scale ?? 1) + (b.offset ?? 0)) * 1e6) / 1e6

/** Edits the steps a row is bound to, in order. */
export async function editRow(tools: readonly PilotTool<never>[], bound: { design: string; binds: PilotSheetBind[] }, key: string, value: number): Promise<RowEdit> {
  const binds = bound.binds.filter((x) => x.key === key)
  if (!binds.length) return { ok: false, reason: 'unbound', summary: assistantText('This size shapes the sketch; ask mimir to build again with it.') }
  const edit = tools.find((t) => t.name === 'design.edit_step')
  if (!edit) return { ok: false, reason: 'refused', summary: 'The design tools are not loaded.' }
  const done: string[] = []
  for (const b of binds) {
    const input = edit.input.safeParse({ design: bound.design, step: b.step, value: stepValue(b, value) })
    if (!input.success) return { ok: false, reason: 'refused', summary: input.error.issues[0]?.message ?? 'That value does not fit this step.' }
    try {
      const out = await edit.run(input.data, {} as never)
      if (out.ok === false) return refused(out.summary)
      done.push(out.summary)
    } catch (e) {
      return refused(e instanceof Error ? e.message : String(e))
    }
  }
  return { ok: true, summary: done.join('; ') }
}
