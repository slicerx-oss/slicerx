// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A modeling tool's one-line answer ends with the last step's note, in the note's own words, when it has one: a fillet
// given the same edge twice says it took it once. A step with no note says nothing more, and a tool of cad.ts and one
// of modeling-tools.ts answer alike. A stand-in engine whose fillet notes are worded as sx-geom's are.
import { afterEach, expect, it } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { connect, data, text } from './helpers'

type R = Record<string, unknown>
// sx-geom's own words for an edge given twice (packages/geom/src/edge.rs); the replay starts the note with a capital
const TWICE = 'edge 2 is edge 1 again and was taken once'
const NOTE = 'Edge 2 is edge 1 again and was taken once.'
const box = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }
const edge = { a: [0, 0, 10], b: [10, 0, 10], face: [5, 0, 10] }

async function engine(op: string, request: unknown) {
  const req = request as R
  // the same edge twice is taken once, and said so
  if (op === 'edge.fillet') return { mesh: box, ...((req['edges'] as unknown[]).length === 2 ? { notes: [TWICE] } : {}) }
  return { mesh: box }
}

interface Out {
  design: string
  landed?: string
  lastStep: { name: string; note?: string }
}

/** The answer a modeling tool gives, from its own reply: verb, step and name, where it landed, and the step's note. */
const said = (verb: string, steps: number, o: Out): string => {
  const line = `${verb}: step ${steps}, ${o.lastStep.name}${o.landed ? `. ${o.landed}` : ''}`
  return o.lastStep.note ? `${line.replace(/\.$/, '')}. ${o.lastStep.note.replace(/\.$/, '')}` : line
}

afterEach(() => clearReplayCache())

it('ends the answer with the note of a fillet given an edge twice, and adds nothing without a note', async () => {
  const h = await connect({ geomEngine: engine })
  for (const edges of [[edge, edge], [edge]]) {
    const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Block' })).output.design
    expect((await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 10 })).isError).toBeFalsy()
    const r = await h.call('slicerx_geom_fillet', { design, edges, radius_mm: 1 })
    expect(r.isError, text(r)).toBeFalsy()
    const { summary, output } = data<{ summary: string; output: Out }>(r)
    expect(summary).toBe(said('Filleted', 2, output))
    if (edges.length === 2) {
      // the engine's sentence once, as its own, at the end
      expect(output.lastStep.note).toBe(NOTE)
      expect(summary.endsWith(`. ${NOTE.replace(/\.$/, '')}`), summary).toBe(true)
      expect(summary.split(TWICE.slice(1)).length).toBe(2)
    } else {
      expect(output.lastStep.note).toBeUndefined()
      expect(summary).not.toContain(TWICE.slice(1))
    }
  }
}, 30_000)

it('answers alike from a tool of each file: a fillet with its note, then a repair on the same part', async () => {
  const h = await connect({ geomEngine: engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Block' })).output.design
  await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 10 })
  const filleted = await h.call('slicerx_geom_fillet', { design, edges: [edge, edge], radius_mm: 1 })
  const repaired = await h.call('slicerx_geom_repair', { design, part: 0 })
  expect(repaired.isError, text(repaired)).toBeFalsy()
  for (const [verb, steps, r] of [['Filleted', 2, filleted], ['Repaired', 3, repaired]] as const) {
    const { summary, output } = data<{ summary: string; output: Out }>(r)
    expect(summary).toBe(said(verb, steps, output))
  }
}, 30_000)
