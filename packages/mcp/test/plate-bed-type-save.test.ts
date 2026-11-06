// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project saved by the shared 3MF writer (the app's save and the MCP server's files) keeps each plate's own plate
// type where other apps read it, `bed_type` in the plate's entry of Metadata/model_settings.config, with the same
// value as `curr_bed_type`; slicerx_inspect_project reads each plate's type back from the saved file.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeProject } from '@slicerx/threemf'
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'

const positions = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0, 0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 20, 20]
const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]
const box = (id: string) => ({ id, name: id, parts: [{ name: id, slot: 1, positions, indices }], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 118, 118, 0, 1] })

/** Each plate type the app sets, and the name the saved file gives it. */
const TYPES: [string, string][] = [
  ['cool', 'Cool Plate'],
  ['engineering', 'Engineering Plate'],
  ['high-temp', 'High Temp Plate'],
  ['textured-pei', 'Textured PEI Plate'],
  ['smooth-pei', 'High Temp Plate'],
  ['textured-cool', 'Textured Cool Plate'],
  ['supertack', 'Supertack Plate'],
]

describe("a saved project's plate types read back over MCP", () => {
  it('slicerx_inspect_project lists each plate type, and none for a plate on the default plate type', async () => {
    const h = await connect()
    const plates = [...TYPES.map(([bedType], i) => ({ name: `Plate ${i + 1}`, objects: [box(`b${i + 1}`)], settings: { bedType } })), { name: 'Default', objects: [box('b8')], settings: {} }]
    const bytes = writeProject({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: { printer_model: 'Bambu Lab P1S', curr_bed_type: 'Textured PEI Plate' }, application: 'SlicerX' })
    const file = join(h.dir, 'saved.3mf')
    writeFileSync(file, bytes)
    // the writer stores its entries, so each plate entry's own metadata reads straight from the bytes
    const own = [...Buffer.from(bytes).toString('latin1').matchAll(/<plate>(.*?)<model_instance>/g)].map((m) => {
      const key = (k: string) => new RegExp(`<metadata key="${k}" value="([^"]*)"/>`).exec(m[1]!)?.[1]
      return [key('bed_type'), key('curr_bed_type')]
    })
    expect(own).toEqual([...TYPES.map(([, name]) => [name, name]), [undefined, undefined]])
    const r = await h.call('slicerx_inspect_project', { file })
    expect(r.isError, text(r)).toBeFalsy()
    const read = data<{ plates: { index: number; bed_type?: string }[] }>(r).plates
    expect(read.map((p) => p.bed_type)).toEqual([...TYPES.map(([, name]) => name), undefined])
  })
})
