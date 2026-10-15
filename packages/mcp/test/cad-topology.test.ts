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

it('reads compact topology through the public tool with a stable mutation revision', async () => {
  const mesh = { name: 'Surface', slot: 1, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'plane', normal: [0, 0, 1], offset: 0 }] } }
  const outDir = mkdtempSync(join(tmpdir(), 'topology-read-')); directories.push(outDir)
  const unused = async (): Promise<never> => { throw new Error('read must not model or open a file') }
  const designs = new Designs({ engine: unused, policy: { outDir, allowDirs: undefined, allowUrls: false } })
  const d = await designs.create('Surface', [mesh]), design = d.id
  const h = await connect({ extraTools: cadTools({ designs, files: { call: unused, path: unused, stl: () => { throw new Error('read must not open an STL') } } }) })
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
  const mesh = { positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'plane', normal: [0, 0, 1], offset: 0 }] } }
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
