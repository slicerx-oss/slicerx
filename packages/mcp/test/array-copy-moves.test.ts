// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An array of separate copies through the tools records the part copied and each copy's move from it, and
// slicerx_design_steps lists them on the step. A stand-in engine: a box for the extrude, two moves for the array.
import { expect, it } from 'vitest'
import { connect, data, text } from './helpers'

const box = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }
const moved = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]

async function engine(op: string): Promise<unknown> {
  if (op === 'array') return { transforms: [moved(0), moved(15), moved(30)] }
  return { mesh: box }
}

type Row = { op: string; copyOf?: { part: number; moves: number[][] } }

it('lists the part an array of separate copies copied, and each copy\'s move from it', async () => {
  const h = await connect({ geomEngine: engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Boats' })).output.design
  const made = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 5, name: 'Boat' })
  expect(made.isError, text(made)).toBeFalsy()
  const r = await h.call('slicerx_geom_array', { design, part: 0, spec: { kind: 'linear', count: 3, step: [15, 0, 0] }, merge: false })
  expect(r.isError, text(r)).toBeFalsy()
  const rows = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design })).output.steps
  const add = rows.find((s) => s.op === 'parts.add')
  expect(add?.copyOf).toEqual({ part: 0, moves: [moved(15), moved(30)] })
})
