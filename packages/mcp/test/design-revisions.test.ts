// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { clearReplayCache, type HistoryMesh, type StepParams } from '@slicerx/cad-history'
import { Designs } from '../src/design'

const directories: string[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const mesh = (name: string): HistoryMesh => ({ name, slot: 1, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] })
const extrude: StepParams = { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 1, heightMm: 1 }, spec: { distanceMm: 1, operation: 'new' } }
function host(engine: (op: string, request: unknown) => Promise<unknown>) {
  const outDir = mkdtempSync(join(tmpdir(), 'design-revisions-'))
  directories.push(outDir)
  return { outDir, designs: new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } }) }
}
afterEach(() => {
  clearReplayCache()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('rejects a stale revision before calling the modeling engine', async () => {
  const engine = vi.fn(async () => { throw new Error('must not model') })
  const { designs } = host(engine)
  const d = await designs.create('Body', [])
  const revision = designs.revision(d.id)
  await designs.add(d, -1, { op: 'parts.add', label: 'Add part', parts: [mesh('First')] })
  const current = designs.revision(d.id)
  await expect(designs.add(d, -1, extrude, undefined, { expectedRevision: revision })).rejects.toMatchObject({ code: 'stale_body', currentRevision: current })
  expect(engine).not.toHaveBeenCalled()
  expect(d.history.steps).toHaveLength(1)
  expect(designs.revision(d.id)).toBe(current)
})

it('rejects a prepared result when another edit commits during its engine call', async () => {
  const started = deferred<void>(), finished = deferred<unknown>()
  const { designs } = host(async () => { started.resolve(); return finished.promise })
  const d = await designs.create('Body', [])
  const revision = designs.revision(d.id)
  const pending = designs.add(d, -1, extrude, undefined, { expectedRevision: revision })
  const refusal = expect(pending).rejects.toMatchObject({ code: 'stale_body' })
  await started.promise
  await designs.add(d, -1, { op: 'parts.add', label: 'Add part', parts: [mesh('Concurrent')] })
  const committed = designs.revision(d.id)
  finished.resolve({ mesh: mesh('Stale') })
  await refusal
  expect(d.parts.map(p => p.name)).toEqual(['Concurrent'])
  expect(d.history.steps).toHaveLength(1)
  expect(designs.revision(d.id)).toBe(committed)
})

it('keeps the committed body and revision if exporting the candidate fails', async () => {
  const { designs, outDir } = host(async () => { throw new Error('unused') })
  const d = await designs.create('Body', [mesh('Original')])
  const revision = designs.revision(d.id), before = structuredClone(d)
  mkdirSync(join(outDir, 'designs', d.id, 'body-2.stl'))
  await expect(designs.add(d, -1, { op: 'parts.add', label: 'Add part', parts: [mesh('Candidate')] }, undefined, { expectedRevision: revision })).rejects.toThrow()
  expect(d).toEqual(before)
  expect(designs.revision(d.id)).toBe(revision)
})
