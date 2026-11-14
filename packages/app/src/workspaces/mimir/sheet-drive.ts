// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A confirmed sheet drives its design: editing a bound row after the build edits the step it set, through the design
// tool a client calls (design.edit_step), so the history replays as a person's edit would. A row that shapes a sketch
// rather than one number is not bound; editing it asks mimir to build again. An edit the design keeps although a
// step then no longer builds is put back, so the row, its note and the design agree on the old size.
import { assistantText } from '@slicerx/contracts'
import type { PilotSheetBind } from '@slicerx/contracts'
import { isKeptEdit, plainEngine, type PilotTool } from '@slicerx/pilot'

/**
 * `detail`: the engine's own words when `summary` says its refusal plainly, for the dev log only. `value`: what the row
 * shows after a failed edit when the design does not hold the old size, because an edit could not be put back.
 */
export type RowEdit = { ok: true; summary: string } | { ok: false; reason: 'unbound' | 'refused'; summary: string; detail?: string; value?: number }

/**
 * A refused edit in plain words: an engine refusal reads as its plain line, with the engine's text kept aside.
 * `kept: false` for an edit the design kept and the sheet then put back, which reads as the refusal it now is.
 */
function refused(text: string, kept = true): Extract<RowEdit, { ok: false }> {
  const plain = plainEngine(text, 'design.edit_step', { kept })
  return plain ? { ok: false, reason: 'refused', summary: plain.shown, detail: plain.raw } : { ok: false, reason: 'refused', summary: text }
}

/** The step number a bound row sets for `value`. */
export const stepValue = (b: PilotSheetBind, value: number): number => Math.round((value * (b.scale ?? 1) + (b.offset ?? 0)) * 1e6) / 1e6

/**
 * Edits the steps a row is bound to, in order. `before` is the row's size before this edit: an edit the design keeps
 * with a step broken is put back to it, last step first, and reads as refused. When putting it back fails too, the
 * design keeps what it then holds and the row says the edit was kept, showing the size the person typed. Without
 * `before` nothing is put back, and the edit reads as refused as it always has.
 */
export async function editRow(
  tools: readonly PilotTool<never>[],
  bound: { design: string; binds: PilotSheetBind[] },
  key: string,
  value: number,
  before?: number,
): Promise<RowEdit> {
  const binds = bound.binds.filter((x) => x.key === key)
  if (!binds.length) return { ok: false, reason: 'unbound', summary: assistantText('This size shapes the sketch; ask mimir to build again with it.') }
  const edit = tools.find((t) => t.name === 'design.edit_step')
  if (!edit) return { ok: false, reason: 'refused', summary: 'The design tools are not loaded.' }
  const step = async (b: PilotSheetBind, v: number): Promise<{ ok?: boolean; summary: string } | { parse: string }> => {
    const input = edit.input.safeParse({ design: bound.design, step: b.step, value: stepValue(b, v) })
    if (!input.success) return { parse: input.error.issues[0]?.message ?? 'That value does not fit this step.' }
    return edit.run(input.data, {} as never)
  }
  const done: string[] = []
  for (const [i, b] of binds.entries()) {
    try {
      const out = await step(b, value)
      if ('parse' in out) return { ok: false, reason: 'refused', summary: out.parse }
      if (out.ok === false) {
        if (!isKeptEdit(out.summary)) return refused(out.summary)
        // the sheet's note reads a kept edit as refused, as the row does once it is put back
        if (before === undefined) return refused(out.summary, false)
        // the design kept this edit with a step broken: put back each step this row changed, last first
        return (await putBack(binds.slice(0, i + 1).reverse(), before, step)) ? refused(out.summary, false) : { ...refused(out.summary), value }
      }
      done.push(out.summary)
    } catch (e) {
      return refused(e instanceof Error ? e.message : String(e))
    }
  }
  return { ok: true, summary: done.join('; ') }
}

/**
 * Edits `binds` back to `before`, in the order given. An edit back the design keeps with a step still broken is put
 * back all the same; a refused one stops it, leaving the design as it then is.
 */
async function putBack(binds: readonly PilotSheetBind[], before: number, step: (b: PilotSheetBind, v: number) => Promise<{ ok?: boolean; summary: string } | { parse: string }>): Promise<boolean> {
  for (const b of binds) {
    try {
      const out = await step(b, before)
      if ('parse' in out || (out.ok === false && !isKeptEdit(out.summary))) return false
    } catch {
      return false
    }
  }
  return true
}
