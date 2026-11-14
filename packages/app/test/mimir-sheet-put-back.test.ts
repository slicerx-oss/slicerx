// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A size typed on the sheet that the design keeps although a step then no longer builds ("Edited step 3, Fillet; step 3
// broke: ...") is put back: the sheet edits each step it changed back to the old size, last first, so the row (which
// shows the old size again), its note (the refusal as before) and the design agree. When putting it back fails too,
// the design keeps what it holds, and the row shows the typed size with a note that the edit was kept.
import type { PilotSheetBind } from '@slicerx/contracts'
import type { PilotTool } from '@slicerx/pilot'
import { defineTool } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { editRow } from '../src/workspaces/mimir/sheet-drive'

const FITS = 'radiusMm: 6 mm does not fit on this face; at most 5.000 mm'
/** The sheet's note for that size on main, from the refusal's own group. */
const MAIN_ROW = 'That size is too big for this part, so the step was not made. Try a smaller size.'

/**
 * A design whose fillet steps keep any radius, but break past 5 mm, as design.edit_step answers it. `refuse` makes
 * edits to those values throw, as a refused edit does, leaving the design unchanged.
 */
function design(values: Record<number, number>, refuse: (step: number, value: number) => boolean = () => false) {
  const calls: [number, number][] = []
  const tool = defineTool<{ design: string; step: number; value: number }>({
    name: 'design.edit_step',
    version: '1',
    description: 'Edit a step',
    source: 'command',
    permission: 'read',
    input: z.object({ design: z.string(), step: z.number(), value: z.number() }),
    async run({ step, value }) {
      calls.push([step, value])
      if (refuse(step, value)) throw new Error('The step did not go through: The part this step works on is gone. The design is unchanged.')
      values[step] = value
      const broken = Object.entries(values).find(([, v]) => v > 5)
      return broken ? { ok: false, summary: `Edited step ${step}, Fillet; step ${broken[0]} broke: ${FITS.replace('6 mm', `${broken[1]} mm`)}` } : { summary: `Edited step ${step}, Fillet` }
    },
  })
  return { tools: [tool as never] as PilotTool<never>[], values, calls }
}

const one = { design: 'dsg_1', binds: [{ key: 'radius', step: 3 }] satisfies PilotSheetBind[] }
const two = { design: 'dsg_1', binds: [{ key: 'radius', step: 3, scale: 0.5 }, { key: 'radius', step: 5 }] satisfies PilotSheetBind[] }

describe('a sheet edit the design keeps with a step broken', () => {
  it('puts the old size back, says it as main does, and a later edit still works', async () => {
    const d = design({ 3: 4 })
    const out = await editRow(d.tools, one, 'radius', 6, 4)
    expect(d.values).toEqual({ 3: 4 })
    expect(d.calls).toEqual([[3, 6], [3, 4]])
    expect(out).toEqual({ ok: false, reason: 'refused', summary: MAIN_ROW, detail: `Edited step 3, Fillet; step 3 broke: ${FITS}` })
    expect(await editRow(d.tools, one, 'radius', 4.5, 4)).toEqual({ ok: true, summary: 'Edited step 3, Fillet' })
    expect(d.values).toEqual({ 3: 4.5 })
  })

  it('puts back every step the row changed, last first', async () => {
    // the row sets step 3 to half its size and step 5 to its size: 6 mm fits step 3 (3 mm) and breaks step 5
    const d = design({ 3: 2, 5: 4 })
    const out = await editRow(d.tools, two, 'radius', 6, 4)
    expect(d.calls).toEqual([[3, 3], [5, 6], [5, 4], [3, 2]])
    expect(d.values).toEqual({ 3: 2, 5: 4 })
    expect(out).toEqual({ ok: false, reason: 'refused', summary: MAIN_ROW, detail: `Edited step 5, Fillet; step 5 broke: ${FITS}` })
  })

  it('when the old size cannot be put back, keeps the design as it is and the row on the typed size', async () => {
    const d = design({ 3: 4 }, (_, v) => v === 4)
    const out = await editRow(d.tools, one, 'radius', 6, 4)
    expect(d.values).toEqual({ 3: 6 })
    expect(d.calls).toEqual([[3, 6], [3, 4]])
    expect(out).toEqual({
      ok: false,
      reason: 'refused',
      summary: 'The edit was made, but step 3 no longer builds: that size is too big for this part. Try a smaller size.',
      detail: `Edited step 3, Fillet; step 3 broke: ${FITS}`,
      value: 6,
    })
  })

  it('leaves a refused edit as it was, with nothing to put back', async () => {
    const d = design({ 3: 4 }, (_, v) => v === 6)
    const out = await editRow(d.tools, one, 'radius', 6, 4)
    expect(d.calls).toEqual([[3, 6]])
    expect(d.values).toEqual({ 3: 4 })
    expect(out).toMatchObject({ ok: false, reason: 'refused', summary: 'The part that step works on is no longer there, so the step was not made.' })
  })

  it('without the old size puts nothing back and reads as refused, as before', async () => {
    const d = design({ 3: 4 })
    expect(await editRow(d.tools, one, 'radius', 6)).toMatchObject({ ok: false, reason: 'refused', summary: MAIN_ROW })
    expect(d.calls).toEqual([[3, 6]])
  })
})
