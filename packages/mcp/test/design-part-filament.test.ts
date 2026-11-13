// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client sets which filament an existing part prints with, as a step (slicerx_design_part_filament): read back in
// the design's parts and its steps, undone and done again, kept when a step before it changes, refused for a slot or a
// part the design does not have, and saved and opened again. A stand-in engine: a box for each extrude, and the saved
// file read back with its parts in filament 1, so the slot that comes back is the step's.
import { expect, it } from 'vitest'
import { readZip } from '../src/zip'
import { connect, data, text } from './helpers'

const box = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }

async function engine(op: string, params?: unknown): Promise<unknown> {
  if (op === 'format.read3mf') {
    // the object id the saved file's history names, so the history is read back with it
    const zip = readZip(Buffer.from((params as { data: { base64: string } }).data.base64, 'base64'))
    const id = (JSON.parse(new TextDecoder().decode(zip.read('Metadata/slicerx_history.json'))) as { bodies: { object: string }[] }).bodies[0]!.object
    return { objects: [{ id: Number(id), name: 'Ship', parts: [{ name: 'Hull', slot: 1, ...box }, { name: 'Funnel', slot: 1, ...box }] }] }
  }
  return { mesh: box }
}

type Part = { index: number; name: string; slot: number }
type Summary = { design: string; steps: number; parts: Part[] }
type Row = { name: string; op: string; state: string }

it('sets an existing part\'s filament as a step, read back, undone, redone, replayed and saved', async () => {
  const h = await connect({ geomEngine: engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Ship' })).output.design
  for (const name of ['Hull', 'Funnel']) {
    const made = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 5, name })
    expect(made.isError, text(made)).toBeFalsy()
  }
  const slots = async () => data<{ output: Summary }>(await h.call('slicerx_design_steps', { design })).output.parts.map((p) => [p.name, p.slot])
  expect(await slots()).toEqual([['Hull', 1], ['Funnel', 1]])

  const set = await h.call('slicerx_design_part_filament', { design, part: 1, slot: 3 })
  expect(set.isError, text(set)).toBeFalsy()
  expect(data<{ summary: string }>(set).summary).toBe('Set Funnel to filament 3: step 3')
  expect(data<{ output: Summary }>(set).output.parts.map((p) => p.slot)).toEqual([1, 3])
  const rows = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design })).output.steps
  expect(rows.at(-1)).toMatchObject({ name: 'Filament 3 for Funnel', op: 'parts.slot', state: 'done' })

  // undone and done again like any step
  expect((await h.call('slicerx_design_undo', { design })).isError).toBeFalsy()
  expect(await slots()).toEqual([['Hull', 1], ['Funnel', 1]])
  expect((await h.call('slicerx_design_redo', { design })).isError).toBeFalsy()
  expect(await slots()).toEqual([['Hull', 1], ['Funnel', 3]])

  // an edit of a step before it replays it, and the part keeps its filament
  const edited = await h.call('slicerx_design_edit_step', { design, step: 1, value: 8 })
  expect(edited.isError, text(edited)).toBeFalsy()
  expect(await slots()).toEqual([['Hull', 1], ['Funnel', 3]])

  // a slot or a part the design does not have
  for (const slot of [0, 33]) {
    const bad = await h.call('slicerx_design_part_filament', { design, part: 0, slot })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('slot: give a filament slot from 1 to 32')
  }
  const gone = await h.call('slicerx_design_part_filament', { design, part: 2, slot: 2 })
  expect(gone.isError).toBe(true)
  expect(text(gone)).toContain('part: the design has 2 parts')
  expect(data<{ output: { steps: unknown[] } }>(await h.call('slicerx_design_steps', { design })).output.steps).toHaveLength(3)

  // saved and opened again: the file's parts read in filament 1, and the step sets the funnel's again
  const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design })).output
  const open = await h.call('slicerx_design_open', { path: saved.path })
  expect(open.isError, text(open)).toBeFalsy()
  const opened = data<{ output: { designs: Summary[] } }>(open).output.designs[0]!
  expect(opened.steps).toBe(3)
  expect(opened.parts.map((p) => [p.name, p.slot])).toEqual([['Hull', 1], ['Funnel', 3]])
}, 30_000)
