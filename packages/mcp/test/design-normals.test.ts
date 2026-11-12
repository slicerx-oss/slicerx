// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design keeps the exact corner normals a replay gives its parts, in memory only: they are on the design after a
// step, and on the copy a receipt holds. Nothing a tool answers with changes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { clearReplayCache, type StepParams } from '@slicerx/cad-history'
import { Designs } from '../src/design'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const extrude: StepParams = { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, spec: { distanceMm: 1, operation: 'new' } }
const up = [0, 0, 0, 0, 0, 0]

/** A kernel that hands solids back as text and reads one triangle with its normals off any of them. */
async function engine(op: string, request: unknown): Promise<unknown> {
  if (op === 'brep.count') return { bodies: 0 }
  if (op === 'brep.tessellate') return { positions: [0, 0, 1, 10, 0, 1, 0, 10, 1], indices: [0, 1, 2], faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 1 }, key: 7 }], normals: [...up] }
  if (op.startsWith('brep.')) return { bodySmb: 'solid' }
  throw new Error(`no mesh engine here (${op}: ${JSON.stringify(request).length} bytes)`)
}

it('keeps the normals of an exact part on the design and on the copy a receipt holds', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const outDir = mkdtempSync(join(tmpdir(), 'design-normals-'))
  directories.push(outDir)
  const designs = new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } })
  const d = await designs.create('Plate', [], undefined, undefined, { exact: true })
  const receipt = await designs.addWithReceipt(d, 0, extrude)
  // the design took the replay's parts
  expect(d.parts).toHaveLength(1)
  expect(d.parts[0]!.normals).toBeInstanceOf(Int16Array)
  expect(Array.from(d.parts[0]!.normals!)).toEqual(up)
  // the receipt's copy is its own, with the same numbers
  const copy = receipt.design.parts[0]!
  expect(copy).not.toBe(d.parts[0])
  expect(copy.normals).toBeInstanceOf(Int16Array)
  expect(copy.normals).not.toBe(d.parts[0]!.normals)
  expect(Array.from(copy.normals!)).toEqual(up)
  // a replay of the design as it is keeps them
  await designs.replay(d)
  expect(Array.from(d.parts[0]!.normals!)).toEqual(up)
})
