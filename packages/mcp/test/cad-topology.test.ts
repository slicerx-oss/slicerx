// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, data, text } from './helpers'
import { Designs } from '../src/design'
import { cadTools } from '../src/cad'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it.each(['measure.feature', 'measure', 'hole.find'])('rejects a scoped operation when the body changes during %s', async (changeAt) => {
  const mesh = { name: 'Surface', slot: 1, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'plane', normal: [0, 0, 1], offset: 0 }] } }
  const outDir = mkdtempSync(join(tmpdir(), 'topology-race-')); directories.push(outDir)
  const engine = vi.fn(async (op: string) => {
    if (op === changeAt) await designs.add(d, -1, { op: 'parts.add', label: 'Add part', parts: [mesh] })
    if (op === 'measure.feature') return { feature: { kind: 'plane', normal: [0, 0, 1], offset: 0 } }
    if (op === 'measure') return { areaMm2: 2 }
    if (op === 'hole.find') return { entry: [0, 0, 1], axis: [0, 0, 1], diameterMm: 4, depthMm: 1, through: true }
    throw new Error(`unexpected operation ${op}`)
  })
  const designs = new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } })
  const d = await designs.create('Surface', [mesh])
  const revision = designs.revision(d.id)
  const unused = async (): Promise<never> => { throw new Error('must not read a file') }
  const h = await connect({ extraTools: cadTools({ designs, files: { engine: false, call: unused, path: unused, stl: () => { throw new Error('must not read an STL') } } }) })
  const reference = { topology: { bodyId: d.id, revision, part: 0, faceKey: 17 } }
  const result = changeAt === 'hole.find'
    ? await h.call('slicerx_geom_hole', { design: d.id, face: reference, diameter_mm: 6 })
    : await h.call('slicerx_geom_measure', { design: d.id, a: reference })
  expect(result.isError, text(result)).toBe(true)
  expect(result.structuredContent).toMatchObject({ error: { code: 'stale_body', details: { bodyId: d.id, currentRevision: designs.revision(d.id) } } })
  expect(designs.revision(d.id)).not.toBe(revision)
  if (changeAt === 'measure.feature') expect(engine.mock.calls.map(([op]) => op)).toEqual(['measure.feature'])
  if (changeAt === 'hole.find') {
    expect(engine.mock.calls.map(([op]) => op)).toEqual(['hole.find'])
    expect(d.history.steps.map(step => step.params.op)).toEqual(['parts.add'])
  }
})

it('reads compact topology through the public tool with a stable mutation revision', async () => {
  const mesh = { name: 'Surface', slot: 1, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'plane', normal: [0, 0, 1], offset: 0 }] } }
  const outDir = mkdtempSync(join(tmpdir(), 'topology-read-')); directories.push(outDir)
  const unused = async (): Promise<never> => { throw new Error('read must not model or open a file') }
  const designs = new Designs({ engine: unused, policy: { outDir, allowDirs: undefined, allowUrls: false } })
  const d = await designs.create('Surface', [mesh]), design = d.id
  const h = await connect({ extraTools: cadTools({ designs, files: { engine: false, call: unused, path: unused, stl: () => { throw new Error('read must not open an STL') } } }) })
  const read = async () => {
    const result = await h.call('slicerx_geom_faces', { design, format: 'topology' })
    expect(result.isError, text(result)).toBeFalsy()
    return data<{ output: { topology: { bodyId: string; revision: string; coordinates: string; representation: string; faces: { faceKey: number; surfaceType: string }[] } } }>(result).output.topology
  }
  const first = await read()
  expect(first).toMatchObject({ bodyId: design, representation: 'mesh', coordinates: 'body_local', faces: [{ faceKey: 17, surfaceType: 'plane' }] })
  expect((await read()).revision).toBe(first.revision)
  await designs.add(d, -1, { op: 'parts.add', label: 'Second surface', parts: [{ ...mesh, faces: { ...mesh.faces, keys: [18] } }] })
  expect((await read()).revision).not.toBe(first.revision)
})

it('refuses topology references for model paths before reading a file', async () => {
  const h = await connect({ geomEngine: async () => { throw new Error('must not model') } })
  const result = await h.call('slicerx_geom_faces', { model: 'not-a-live-design.stl', format: 'topology' })
  expect(result.isError).toBe(true)
  expect(text(result)).toContain('live design')
})

it('refuses a stale scoped push through the public tool before modeling', async () => {
  const mesh = { name: 'Surface', slot: 1, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'plane', normal: [0, 0, 1], offset: 0 }] } }
  const engine = vi.fn(async (op: string) => {
    if (op !== 'shape.extrude') throw new Error(`unexpected modeling ${op}`)
    return { mesh }
  })
  const h = await connect({ geomEngine: engine })
  const created = await h.call('slicerx_design_new', { name: 'Surface' })
  const design = data<{ output: { design: string } }>(created).output.design
  const add = () => h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 2, heightMm: 2 }, distance_mm: 1 })
  expect((await add()).isError).toBeFalsy()
  const read = data<{ output: { topology: { revision: string } } }>(await h.call('slicerx_geom_faces', { design, format: 'topology' })).output.topology
  expect((await add()).isError).toBeFalsy()
  engine.mockClear()
  const result = await h.call('slicerx_geom_push_pull', { design, face: { topology: { bodyId: design, revision: read.revision, part: 0, faceKey: 17 } }, distance_mm: 2 })
  expect(result.isError).toBe(true)
  expect(text(result)).toContain('stale_body')
  expect(result.structuredContent).toMatchObject({ error: { code: 'stale_body', details: { operationResult: { status: 'refused', reason: 'stale_body', priorRevision: read.revision } } } })
  expect(engine).not.toHaveBeenCalled()
})

it('reports the scoped push receipt even when another edit lands before the response', async () => {
  const mesh = { name: 'Surface', slot: 1, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'plane', normal: [0, 0, 1], offset: 0 }] } }
  const outDir = mkdtempSync(join(tmpdir(), 'topology-receipt-')); directories.push(outDir)
  const engine = async (op: string) => {
    if (op !== 'face.push') throw new Error(`unexpected modeling ${op}`)
    return { mesh: { ...mesh, positions: [0, 0, 2, 2, 0, 2, 0, 2, 2] } }
  }
  const designs = new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } })
  const d = await designs.create('Surface', [mesh])
  const revision = designs.revision(d.id)
  const add = designs.addWithReceipt.bind(designs)
  designs.addWithReceipt = async (...args) => {
    const receipt = await add(...args)
    await designs.add(d, -1, { op: 'parts.add', label: 'Add part', parts: [mesh] })
    return receipt
  }
  const unused = async (): Promise<never> => { throw new Error('must not read a file') }
  const h = await connect({ extraTools: cadTools({ designs, files: { engine: false, call: unused, path: unused, stl: () => { throw new Error('must not read an STL') } } }) })
  const result = await h.call('slicerx_geom_push_pull', { design: d.id, face: { topology: { bodyId: d.id, revision, part: 0, faceKey: 17 } }, distance_mm: 2 })
  expect(result.isError, text(result)).toBeFalsy()
  const output = data<{ output: { steps: number; topology: { revision: string }; operationResult: { status: string; revision: string; priorRevision: string } } }>(result).output
  expect(d.history.steps).toHaveLength(2)
  expect(output.steps).toBe(1)
  expect(output.operationResult).toMatchObject({ status: 'applied', priorRevision: revision, revision: output.topology.revision })
  expect(output.topology.revision).not.toBe(designs.revision(d.id))
})

it('reports an applied hole edit when its later read-back fails', async () => {
  const mesh = { name: 'Surface', slot: 1, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], radius: 2 }] } }
  const outDir = mkdtempSync(join(tmpdir(), 'hole-receipt-')); directories.push(outDir)
  let reads = 0
  const engine = async (op: string) => {
    if (op === 'hole.apply') return { mesh }
    if (op === 'hole.find') {
      if (++reads > 1) throw new Error('measurement unavailable')
      return { entry: [0, 0, 1], axis: [0, 0, 1], diameterMm: 4, depthMm: 1, through: true }
    }
    throw new Error(`unexpected operation ${op}`)
  }
  const designs = new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } })
  const d = await designs.create('Hole', [mesh]), revision = designs.revision(d.id)
  const unused = async (): Promise<never> => { throw new Error('must not read a file') }
  const h = await connect({ extraTools: cadTools({ designs, files: { engine: false, call: unused, path: unused, stl: () => { throw new Error('must not read an STL') } } }) })
  const result = await h.call('slicerx_geom_hole', { design: d.id, face: { topology: { bodyId: d.id, revision, part: 0, faceKey: 17 } }, diameter_mm: 6 })
  expect(result.isError, text(result)).toBeFalsy()
  expect(d.history.steps).toHaveLength(1)
  expect(data(result)).toMatchObject({ output: { after: null, operationResult: { status: 'applied', priorRevision: revision,
    revision: designs.revision(d.id), verification: { status: 'failed', reason: 'measurement unavailable' } } } })
  expect(text(result)).toContain('the edit was applied but its read-back failed')
})

it.each([
  { request: { diameter_mm: 6 }, status: 'failed' },
  { request: { diameter_mm: 4, counterbore: { diameter_mm: 8, depth_mm: 0.5 } }, status: 'unverified' },
])('does not overstate scoped hole verification: $status', async ({ request, status }) => {
  const mesh = { name: 'Hole', slot: 1, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], radius: 2 }] } }
  const outDir = mkdtempSync(join(tmpdir(), 'hole-verification-')); directories.push(outDir)
  const engine = async (op: string) => {
    if (op === 'hole.apply') return { mesh }
    if (op === 'hole.find') return { entry: [0, 0, 1], axis: [0, 0, 1], diameterMm: 4, depthMm: 1, through: true }
    throw new Error(`unexpected operation ${op}`)
  }
  const designs = new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } })
  const d = await designs.create('Hole', [mesh]), revision = designs.revision(d.id)
  const unused = async (): Promise<never> => { throw new Error('must not read a file') }
  const h = await connect({ extraTools: cadTools({ designs, files: { engine: false, call: unused, path: unused, stl: () => { throw new Error('must not read an STL') } } }) })
  const result = await h.call('slicerx_geom_hole', { design: d.id, face: { topology: { bodyId: d.id, revision, part: 0, faceKey: 17 } }, ...request })
  expect(result.isError, text(result)).toBeFalsy()
  expect(data(result)).toMatchObject({ output: { after: { diameterMm: 4 }, operationResult: { status: 'applied', verification: { status, toleranceMm: 0.01 } } } })
  const after = data<{ output: { after: Record<string, unknown> } }>(result).output.after
  expect(after).not.toHaveProperty('counterbore')
  expect(after).not.toHaveProperty('head')
})

it.each([false, true])('refuses invalid or removed scoped holes before committing: removed=%s', async (removed) => {
  const mesh = { name: 'Hole', slot: 1, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], radius: 2 }] } }
  const outDir = mkdtempSync(join(tmpdir(), 'hole-invalid-')); directories.push(outDir)
  const engine = vi.fn(async (op: string) => {
    if (op === 'hole.apply') return { mesh }
    if (op === 'hole.find') return { entry: [0, 0, 1], axis: [0, 0, 1], diameterMm: NaN, depthMm: 1, through: true }
    throw new Error(`unexpected operation ${op}`)
  })
  const designs = new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } })
  const d = await designs.create('Hole', [mesh]), revision = designs.revision(d.id)
  const unused = async (): Promise<never> => { throw new Error('must not read a file') }
  const h = await connect({ extraTools: cadTools({ designs, files: { engine: false, call: unused, path: unused, stl: () => { throw new Error('must not read an STL') } } }) })
  if (removed) designs.get = () => { throw Object.assign(new Error('The body was removed.'), { code: 'not_found' }) }
  const result = await h.call('slicerx_geom_hole', { design: d.id, face: { topology: { bodyId: d.id, revision, part: 0, faceKey: 17 } }, diameter_mm: 6 })
  expect(result.isError, text(result)).toBe(true)
  const code = removed ? 'stale_body' : 'invalid_model'
  expect(result.structuredContent).toMatchObject({ error: { code, details: { operationResult: { status: 'refused', reason: code, priorRevision: revision, revision: removed ? null : revision } } } })
  expect(engine.mock.calls.map(([op]) => op)).toEqual(removed ? [] : ['hole.find'])
  expect(d.history.steps).toHaveLength(0)
  if (removed) expect(() => designs.revision(d.id)).toThrow('The body was removed.')
  else expect(designs.revision(d.id)).toBe(revision)
})
