// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An exact design whose part's solid grows past the largest solid text a part keeps: the step that grew it is refused
// with the size and the limit in the reply, and the design is unchanged. One just under the limit goes through.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MAX_SOLID_TEXT, clearReplayCache, solidTooBig, unstopped, type StepParams } from '@slicerx/cad-history'
import { Designs } from '../src/design'

const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }
const box: StepParams = { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } }
const hole = { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }], label: 'Hole 4 mm' } as StepParams
const dirs: string[] = []

/** The design host on an engine whose kernel answers a cut with a solid text `chars` long. */
function host(chars: number) {
  const outDir = mkdtempSync(join(tmpdir(), 'design-solid-cap-'))
  dirs.push(outDir)
  const engine = async (op: string) => {
    if (op === 'brep.count') return { bodies: 0 }
    if (op === 'brep.tessellate') return { ...tri, faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op === 'brep.subtract') return { body: 1, bodySmb: 'x'.repeat(chars) }
    if (op.startsWith('brep.')) return { body: 1, bodySmb: `${op}-solid` }
    throw new Error(`unexpected ${op}`)
  }
  return new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } })
}

afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

it('takes a cut whose solid is at the limit', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = host(MAX_SOLID_TEXT)
  const d = await h.create('Plate', [], undefined, undefined, { exact: true })
  await h.add(d, 0, box)
  await h.add(d, 0, hole)
  expect(d.history.steps).toHaveLength(2)
  expect(d.status.map((s) => s.state)).toEqual(['done', 'done'])
})

it('refuses a cut whose solid passes the limit, with the size and the limit, and keeps the design as it was', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = host(MAX_SOLID_TEXT + 1)
  const d = await h.create('Plate', [], undefined, undefined, { exact: true })
  await h.add(d, 0, box)
  await expect(h.add(d, 0, hole)).rejects.toThrow(`Exact replay stopped: ${unstopped(solidTooBig(MAX_SOLID_TEXT + 1, true))}. The design is unchanged.`)
  expect(d.history.steps).toHaveLength(1)
})
