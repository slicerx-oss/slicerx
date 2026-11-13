// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client names the upper piece of a cut that keeps both (slicerx_geom_cut `name`): the part comes back with that
// name, keeps it when a step before it changes and when the design is saved and opened again, and a cut without a
// name calls it "<part> top" as before. A name on a cut that keeps one piece is refused. A stand-in engine: a box for
// each extrude and for each side of a cut, and the saved file read back with the parts its history makes.
import { expect, it } from 'vitest'
import { readZip } from '../src/zip'
import { connect, data, text } from './helpers'

const box = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }

async function engine(op: string, params?: unknown): Promise<unknown> {
  if (op === 'format.read3mf') {
    // the object id the saved file's history names, so the history is read back with it
    const zip = readZip(Buffer.from((params as { data: { base64: string } }).data.base64, 'base64'))
    const id = (JSON.parse(new TextDecoder().decode(zip.read('Metadata/slicerx_history.json'))) as { bodies: { object: string }[] }).bodies[0]!.object
    return { objects: [{ id: Number(id), name: 'Ship', parts: [{ name: 'Hull', slot: 1, ...box }] }] }
  }
  if (op === 'cut') return { below: box, above: box }
  return { mesh: box }
}

type Summary = { design: string; steps: number; parts: { index: number; name: string }[] }

it('names the upper piece of a cut, keeps the name through an edit, a save and an open, and refuses it on a cut that keeps one piece', async () => {
  const h = await connect({ geomEngine: engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Ship' })).output.design
  const made = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 5, name: 'Hull' })
  expect(made.isError, text(made)).toBeFalsy()
  const names = async () => data<{ output: Summary }>(await h.call('slicerx_design_steps', { design })).output.parts.map((p) => p.name)

  const cut = await h.call('slicerx_geom_cut', { design, plane: { axis: 'z', at: 2 }, name: 'Upper hull' })
  expect(cut.isError, text(cut)).toBeFalsy()
  expect(data<{ output: Summary }>(cut).output.parts.map((p) => p.name)).toEqual(['Hull', 'Upper hull'])

  // the upper piece cut again without a name: "<part> top", as before
  expect((await h.call('slicerx_geom_cut', { design, part: 1, plane: { axis: 'z', at: 4 } })).isError).toBeFalsy()
  expect(await names()).toEqual(['Hull', 'Upper hull', 'Upper hull top'])

  // a name on a cut that keeps one piece is refused, and nothing is added
  for (const keep of ['below', 'above']) {
    const bad = await h.call('slicerx_geom_cut', { design, plane: { axis: 'z', at: 1 }, keep, name: 'Keel' })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('name: only a cut that keeps both pieces makes a new part; leave name out')
  }
  expect(data<{ output: { steps: unknown[] } }>(await h.call('slicerx_design_steps', { design })).output.steps).toHaveLength(3)

  // the first cut moved: its upper piece keeps its name
  const edited = await h.call('slicerx_design_edit_step', { design, step: 2, value: 3 })
  expect(edited.isError, text(edited)).toBeFalsy()
  expect(await names()).toEqual(['Hull', 'Upper hull', 'Upper hull top'])

  // saved and opened again: the steps make the same parts, by the same names
  const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design })).output
  const open = await h.call('slicerx_design_open', { path: saved.path })
  expect(open.isError, text(open)).toBeFalsy()
  const opened = data<{ output: { designs: Summary[] } }>(open).output.designs[0]!
  expect(opened.steps).toBe(3)
  expect(opened.parts.map((p) => p.name)).toEqual(['Hull', 'Upper hull', 'Upper hull top'])
}, 30_000)
