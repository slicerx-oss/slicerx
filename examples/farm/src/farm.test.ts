// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import type { JobFile } from '@slicerx/contracts'
import { queuePlates, type QueueTarget } from './queue.ts'
import { isStale, listJobs } from './scan.ts'
import { buildRequest, jobName, sliceModel } from './slice.ts'

const work = await mkdtemp(join(tmpdir(), 'sx-farm-test-'))
after(() => rm(work, { recursive: true, force: true }))
const bed = { widthMm: 256, depthMm: 256, heightMm: 250 }
const cube = resolve(import.meta.dirname, '../../../packages/core/cli/tests/fixtures/cube.stl')

describe('requests', () => {
  it('names output folders from the model file name', () => {
    assert.equal(jobName('/models/Gear v2 (final).stl'), 'Gear-v2-final')
    assert.equal(jobName('cube.3MF'), 'cube')
    assert.equal(jobName('###.stl'), 'model')
  })

  it('builds a one object request with an absolute mesh path', () => {
    const r = buildRequest('models/cube.stl', { config: { layer_height: 0.2 }, bed, flavor: 'klipper' })
    assert.equal(r['schemaVersion'], 1)
    assert.deepEqual(r['meshes'], { model: resolve('models/cube.stl') })
    assert.deepEqual(r['config'], { layer_height: 0.2 })
    assert.deepEqual(r['options'], { flavor: 'klipper' })
    assert.equal(buildRequest('a.stl', { config: {}, bed })['options'], undefined)
  })
})

describe('scanning', () => {
  it('lists models only and slices again after a change', async () => {
    const dir = join(work, 'scan')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'b.stl'), 'solid b\nendsolid b\n')
    await writeFile(join(dir, 'a.3mf'), 'PK')
    await writeFile(join(dir, 'notes.txt'), 'not a model')
    const jobs = await listJobs(dir, join(work, 'scan-out'))
    assert.deepEqual(jobs.map((j) => j.name), ['a', 'b'])
    const b = jobs[1]!
    assert.equal(await isStale(b), true)
    await mkdir(b.outDir, { recursive: true })
    await writeFile(join(b.outDir, 'result.json'), '{}')
    const past = new Date(Date.now() - 60_000)
    await utimes(b.model, past, past)
    assert.equal(await isStale(b), false)
    const later = new Date(Date.now() + 60_000)
    await utimes(b.model, later, later)
    assert.equal(await isStale(b), true)
  })
})

describe('queueing', () => {
  const added: { printerId: string; file: JobFile; title?: string }[] = []
  const hub: QueueTarget = {
    queue: {
      add: async (printerId, file, opts) => {
        added.push({ printerId, file, ...(opts?.title ? { title: opts.title } : {}) })
        return { item: { id: `q-${added.length}`, state: 'waiting' } }
      },
    },
  }
  const gcode = join(work, 'plate.gcode')

  it('queues nothing without a yes', async () => {
    await writeFile(gcode, 'G28\nG1 X10\n')
    const asked: string[] = []
    const ids = await queuePlates(hub, 'bay-4', [{ name: 'plate', gcodePath: gcode }], async (q) => (asked.push(q), false), () => {})
    assert.deepEqual(ids, [])
    assert.equal(added.length, 0)
    assert.match(asked[0]!, /approval in the SlicerX app/)
  })

  it('queues each plate with its SHA-256 after a yes', async () => {
    const ids = await queuePlates(hub, 'bay-4', [{ name: 'plate', gcodePath: gcode }], async () => true, () => {})
    assert.deepEqual(ids, ['q-1'])
    const sent = added[0]!
    assert.equal(sent.printerId, 'bay-4')
    assert.equal(sent.file.name, 'plate.gcode')
    assert.equal(sent.file.kind, 'gcode')
    assert.equal(sent.file.sha256, createHash('sha256').update(await readFile(gcode)).digest('hex'))
    assert.equal(new TextDecoder().decode(sent.file.data), 'G28\nG1 X10\n')
  })
})

// Runs only where sx is built: SX_BIN=target/release/sx node --test src/farm.test.ts
describe('slicing with sx', { skip: !process.env['SX_BIN'] || !existsSync(process.env['SX_BIN']) }, () => {
  it('writes G-code, a preview and a result for the test cube', async () => {
    const model = join(work, 'cube.stl')
    await copyFile(cube, model)
    const out = join(work, 'cube-out')
    const r = await sliceModel(process.env['SX_BIN']!, model, out, { config: { layer_height: 0.2 }, bed })
    assert.ok(r.layerCount > 0)
    assert.ok(r.gcodeBytes > 0 && r.previewBytes > 0)
    assert.equal((await readFile(join(out, 'slice.sxpv'))).subarray(0, 4).toString(), 'SXPV')
    assert.match(await readFile(join(out, 'slice.gcode'), 'utf8'), /G1 /)
  })
})
