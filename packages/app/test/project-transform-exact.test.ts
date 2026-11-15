// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A saved project opens with each object exactly where it stood: every entry of a build item's transform is written as
// the shortest decimal that reads back to the same number, so a turned, moved and scaled object comes back entry for
// entry, not rounded to 4 decimals. The file has no negative zero, so a -0 entry comes back as 0.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { parseTransform } from '../src/export/model-scan'
import { transformAttr, writeProject } from '../src/export/threemf'
import { unzipStored } from '../src/export/zip'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose, type Mat4 } from '../src/plate/transform'
import type { PlateEntry, PlateMeta } from '../src/state/store'

const BED = { widthMm: 256, depthMm: 256 }

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
// turned 30 degrees about z, moved by odd decimals and scaled on every axis
const TURNED = compose({ position: [37.3, -21.7, 12.35], rotation: [0, 0, 30], scale: [1.25, 0.8, 1.5] })
// mirrored in x and turned the other way
const MIRRORED = compose({ position: [90.15, 110.85, 0], rotation: [0, 0, -45], scale: [-1, 1, 1] })

function entry(id: string, transform: Mat4): PlateEntry {
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] } as MeshHandle
  return { id, name: `Part ${id}`, handle, parts: [{ ...boxMesh(10, 10, 10), name: 'body', slot: 1 }], colors: ['#fff'], transform }
}

// a project with print settings, so the reader keeps each object where the file puts it
const saved = (): Uint8Array => {
  const plates: PlateMeta[] = [{ id: 'p1', name: 'Plate 1', objects: [entry('turned', TURNED), entry('plain', IDENTITY), entry('mirrored', MIRRORED)], settings: {} }]
  return writeProject({ plates, bed: BED, settings: { layer_height: '0.2' } })
}

/** `m` as the file can hold it: negative zero is written as 0. */
const asWritten = (m: readonly number[]) => m.map((v) => (v === 0 ? 0 : v))

/** The entries that differ by Object.is, as text for the failure message; empty when every entry is the same. */
function differ(got: readonly number[], want: readonly number[]): string[] {
  return want.flatMap((v, i) => (Object.is(got[i], v) ? [] : [`[${i}] ${got[i]} for ${v}`]))
}

beforeAll(() => readProjectsWithGeom(false))
afterAll(() => readProjectsWithGeom(true))

describe('a 3MF item transform reads back exactly', () => {
  it('a turned, an unturned and a mirrored object open entry for entry as they were saved', async () => {
    const project = await readProject(saved(), BED)
    const objects = project.plates[0]!.objects
    expect(objects.map((o) => o.name)).toEqual(['Part turned', 'Part plain', 'Part mirrored'])
    expect(differ(objects[0]!.transform, asWritten(TURNED))).toEqual([])
    expect(differ(objects[1]!.transform, asWritten(IDENTITY))).toEqual([])
    expect(differ(objects[2]!.transform, asWritten(MIRRORED))).toEqual([])
  })

  it('the written text parses to the same numbers, in plain digits, and whole numbers stay short', () => {
    const model = new TextDecoder().decode(unzipStored(saved()).get('3D/3dmodel.model'))
    const texts = [...model.matchAll(/<item [^>]*transform="([^"]*)"/g)].map((m) => m[1]!)
    expect(texts).toHaveLength(3)
    expect(texts[1]).toBe('1 0 0 0 1 0 0 0 1 0 0 0')
    for (const [text, want] of texts.map((t, i) => [t, [TURNED, IDENTITY, MIRRORED][i]!] as const)) {
      expect(text).not.toMatch(/e|E|(^|\s)-0(\s|$)/)
      expect(differ(parseTransform(text)!, asWritten(want))).toEqual([])
    }
  })

  it('a quarter turn and numbers far from 1 are spelled out without an exponent and read back the same', () => {
    // cos(90 degrees) is 6.1e-17, which String() writes with an exponent
    const quarter = compose({ position: [0.1 + 0.2, 1e-7, -2.5e-20], rotation: [90, 0, 0], scale: [1, 1, 1] })
    const text = transformAttr(quarter)
    expect(text).not.toMatch(/e|E/)
    expect(differ(parseTransform(text)!, asWritten(quarter))).toEqual([])
    expect(text.split(' ').slice(9)).toEqual(['0.30000000000000004', '0.0000001', '-0.000000000000000000025'])
  })
})
