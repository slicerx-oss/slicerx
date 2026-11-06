// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the engine's 3MF reader left out of a project, or read another way, comes back with slicerx_design_open as
// `notes`, so a client is told as a person opening the file in the app is: a painting in a newer facets JSON version
// it skipped, for example. The server reads the file with the engine it was given; here a stand-in answers.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, text } from './helpers'

const SKIPPED_PAINT = 'paint in a newer facets JSON version was skipped'
const POSITIONS = [0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0, 0, 0, 10, 10, 0, 10, 0, 10, 10, 10, 10, 10]
const INDICES = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]

/** An engine that reads every 3MF as one box object with `notes`. */
const engineWith = (notes: string[]) => async (op: string): Promise<unknown> => {
  if (op !== 'format.read3mf') throw new Error(`unexpected operation ${op}`)
  return { unitScale: 1, objects: [{ id: 1, name: 'Box', transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], parts: [{ name: 'Box', kind: 'normal', kindText: null, slot: 1, positions: POSITIONS, indices: INDICES, paint: null }] }], notes }
}

async function open(notes: string[]) {
  const h = await connect({ geomEngine: engineWith(notes) })
  const file = join(h.dir, 'painted.3mf')
  writeFileSync(file, writeZip([{ name: '3D/3dmodel.model', data: '<?xml version="1.0"?><model unit="millimeter"/>' }]))
  const r = await h.call('slicerx_design_open', { path: file })
  expect(r.isError, text(r)).toBeFalsy()
  return { r, output: data<{ output: { designs: { name: string }[]; notes?: string[] } }>(r).output }
}

describe('slicerx_design_open reads back what the engine left out', () => {
  it('gives the engine notes with the designs, and says so in its answer', async () => {
    const { r, output } = await open([SKIPPED_PAINT, SKIPPED_PAINT])
    expect(output.designs.map((d) => d.name)).toEqual(['Box'])
    expect(output.notes).toEqual([SKIPPED_PAINT])
    expect(text(r)).toContain(SKIPPED_PAINT)
  })

  it('has no notes when the file was read whole', async () => {
    const { output } = await open([])
    expect(output.designs.map((d) => d.name)).toEqual(['Box'])
    expect(output.notes).toBeUndefined()
  })
})
