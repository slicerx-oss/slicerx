// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client renames an existing part as a step (slicerx_design_rename_part): read back in the design's parts and its
// steps, undone and done again, kept when a step before it changes, refused in plain words for an empty name, one too
// long, another part's name or the part's own, and for a part the design does not have, and saved and opened again. A
// stand-in engine: a box for each extrude, and the saved file read back with its parts under the names they were made
// with, so the name that comes back is the step's.
import { expect, it } from 'vitest'
import { readZip } from '../src/zip'
import { connect, data, text } from './helpers'

const box = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }

async function engine(op: string, params?: unknown): Promise<unknown> {
  if (op === 'format.read3mf') {
    // the object id the saved file's history names, so the history is read back with it
    const zip = readZip(Buffer.from((params as { data: { base64: string } }).data.base64, 'base64'))
    const id = (JSON.parse(new TextDecoder().decode(zip.read('Metadata/slicerx_history.json'))) as { bodies: { object: string }[] }).bodies[0]!.object
    return { objects: [{ id: Number(id), name: 'Ship', parts: [{ name: 'Hull', slot: 1, ...box }, { name: 'Hull top top', slot: 1, ...box }] }] }
  }
  return { mesh: box }
}

type Summary = { design: string; steps: number; parts: { index: number; name: string }[] }
type Row = { name: string; op: string; state: string }

it('renames an existing part as a step, read back, undone, redone, replayed, refused in words and saved', async () => {
  const h = await connect({ geomEngine: engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Ship' })).output.design
  for (const name of ['Hull', 'Hull top top']) {
    const made = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 5, name })
    expect(made.isError, text(made)).toBeFalsy()
  }
  const parts = async () => data<{ output: Summary }>(await h.call('slicerx_design_steps', { design })).output.parts.map((p) => p.name)
  expect(await parts()).toEqual(['Hull', 'Hull top top'])

  const renamed = await h.call('slicerx_design_rename_part', { design, part: 1, name: '  Decks ' })
  expect(renamed.isError, text(renamed)).toBeFalsy()
  expect(data<{ summary: string }>(renamed).summary).toBe('Renamed Hull top top to Decks: step 3')
  expect(data<{ output: Summary }>(renamed).output.parts.map((p) => p.name)).toEqual(['Hull', 'Decks'])
  const rows = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design })).output.steps
  expect(rows.at(-1)).toMatchObject({ name: 'Rename Hull top top to Decks', op: 'parts.name', state: 'done' })

  // undone and done again like any step
  expect((await h.call('slicerx_design_undo', { design })).isError).toBeFalsy()
  expect(await parts()).toEqual(['Hull', 'Hull top top'])
  expect((await h.call('slicerx_design_redo', { design })).isError).toBeFalsy()
  expect(await parts()).toEqual(['Hull', 'Decks'])

  // an edit of a step before it replays it, and the part keeps its name
  const edited = await h.call('slicerx_design_edit_step', { design, step: 1, value: 8 })
  expect(edited.isError, text(edited)).toBeFalsy()
  expect(await parts()).toEqual(['Hull', 'Decks'])

  // refused in plain words, with nothing added
  const refused: [Record<string, unknown>, string][] = [
    [{ part: 1, name: ' \n ' }, 'name: give the part a name'],
    [{ part: 1, name: 'x'.repeat(121) }, 'name: keep the name to 120 characters (this one has 121)'],
    [{ part: 1, name: 'HULL' }, 'name: part 0 is already called Hull; give this one a name no other part has'],
    [{ part: 1, name: 'Decks' }, 'name: part 1 is already called Decks'],
    [{ part: 2, name: 'Funnel' }, 'part: the design has 2 parts'],
  ]
  for (const [args, words] of refused) {
    const bad = await h.call('slicerx_design_rename_part', { design, ...args })
    expect(bad.isError, JSON.stringify(args)).toBe(true)
    expect(text(bad)).toContain(words)
  }
  // a change of case only is a new name
  const cased = await h.call('slicerx_design_rename_part', { design, part: 1, name: 'decks' })
  expect(cased.isError, text(cased)).toBeFalsy()
  expect(data<{ output: { steps: unknown[] } }>(await h.call('slicerx_design_steps', { design })).output.steps).toHaveLength(4)

  // saved and opened again: the file's parts come under the names they were made with, and the steps rename again
  const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design })).output
  const open = await h.call('slicerx_design_open', { path: saved.path })
  expect(open.isError, text(open)).toBeFalsy()
  const opened = data<{ output: { designs: Summary[] } }>(open).output.designs[0]!
  expect(opened.steps).toBe(4)
  expect(opened.parts.map((p) => p.name)).toEqual(['Hull', 'decks'])
}, 30_000)
