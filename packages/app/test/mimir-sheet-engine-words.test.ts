// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A size changed on the sheet after the build edits its step. When the engine refuses the edit, the sheet's note says
// so in plain words with what to try; the engine's own text is kept for the dev log, never shown in the note.
import type { PilotTool } from '@slicerx/pilot'
import { READ_ONLY, defineTool } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { editRow } from '../src/workspaces/mimir/sheet-drive'

const bound = { design: 'dsg_1', binds: [{ key: 'radius', step: 3 }] }

function edit(run: () => Promise<{ ok?: boolean; summary: string }>): PilotTool<never>[] {
  const tool = defineTool<{ design: string; step: number; value: number }>({
    name: 'design.edit_step',
    version: '1',
    description: 'Edit a step',
    source: 'command',
    permission: 'read', hints: READ_ONLY,
    input: z.object({ design: z.string(), step: z.number(), value: z.number() }),
    run,
  })
  return [tool as never]
}

describe('a refused sheet edit in plain words', () => {
  it('says a size that does not fit plainly, keeping the engine text aside', async () => {
    // design-tools.ts design.edit_step, with edge.rs's refusal as the history replay passes it on
    const raw = 'Edited step 3, Fillet; step 3 broke: radiusMm: 6 mm does not fit on this face; at most 5.000 mm'
    const out = await editRow(edit(async () => ({ ok: false, summary: raw })), bound, 'radius', 6)
    expect(out).toMatchObject({ ok: false, reason: 'refused', summary: 'That size is too big for this part, so the step was not made. Try a smaller size.', detail: raw })
    expect(out.summary).not.toMatch(/radiusMm|broke/)
  })

  it('says a thrown engine refusal plainly', async () => {
    const raw = 'The step did not go through: The result is unsafe at mesh storage precision (collapsed triangles); change the cut or placement. The design is unchanged.'
    const out = await editRow(edit(async () => { throw new Error(raw) }), bound, 'radius', 6)
    expect(out.summary).toMatch(/too thin/)
    expect(out.summary).not.toMatch(/storage precision|collapsed/)
    expect(out).toMatchObject({ detail: raw })
  })

  it('keeps an edit that went through as it was', async () => {
    const out = await editRow(edit(async () => ({ summary: 'Edited step 3, Fillet' })), bound, 'radius', 4)
    expect(out).toEqual({ ok: true, summary: 'Edited step 3, Fillet' })
  })
})
