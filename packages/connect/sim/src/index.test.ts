// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { DemoFleet, JobFile, PrinterEvent } from '@slicerx/contracts'
import { createFleetSim, FleetSimError } from './index.ts'
import { runHostContract } from './contract-suite.ts'

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/demo-fleet.json', import.meta.url), 'utf8')) as DemoFleet
const file = (name = 'cube.gcode'): JobFile => ({ name, kind: 'gcode', data: new ArrayBuffer(4096), sha256: '00' })

runHostContract('fleet-sim', () => {
  let now = 1_700_000_000_000
  const sim = createFleetSim(fixture, { clock: () => now })
  return { host: sim, mint: (a, id) => sim.permit.mint(a, id), advance: (ms) => { now += ms; sim.tick(ms) } }
})

test('demo data has six printers and one example fleet', async () => {
  const sim = createFleetSim(fixture)
  const list = await sim.list()
  assert.deepEqual(list.map((p) => `${p.name}:${p.model}`), ['Bay 1:X1 Carbon', 'Bay 2:P1S', 'Bay 3:MK4S', 'Bay 4:Voron 2.4 350', 'Bay 5:K1 Max', 'Bay 6:H2C'])
  assert.equal((await sim.status('bay-5')).state, 'offline')
  const fleets = await sim.fleets()
  assert.deepEqual(fleets.map((f) => f.name), ['Workshop'])
  assert.deepEqual(fleets[0]?.printerIds, ['bay-1', 'bay-2', 'bay-3'])
  assert.equal((await sim.status('bay-1')).slots.length, 4)
})

test('a token for one printer fails on another and cannot be reused', async () => {
  const sim = createFleetSim(fixture)
  const t = sim.permit.mint('upload', 'bay-2')
  await assert.rejects(sim.upload('bay-4', file(), t), (e: FleetSimError) => e.code === 'approval_invalid')
  const t2 = sim.permit.mint('upload', 'bay-2')
  await sim.upload('bay-2', file(), t2)
  await assert.rejects(sim.upload('bay-2', file(), t2), (e: FleetSimError) => e.code === 'approval_invalid')
})

test('a finished job fires job_finished and cooling starts', async () => {
  const sim = createFleetSim(fixture)
  const events: PrinterEvent[] = []
  sim.subscribe('bay-1', (e) => events.push(e))
  for (let i = 0; i < 400; i++) sim.tick(60_000)
  assert.ok(events.some((e) => e.type === 'job_finished' && e.ok))
  assert.equal((await sim.status('bay-1')).state, 'finished')
})

test('spoolman tools read and require a token to write', async () => {
  const sim = createFleetSim(fixture)
  const spools = (await sim.callTool('spoolman', 'spoolman.list_spools', { material: 'PLA' })) as { id: number }[]
  assert.ok(spools.length >= 4)
  await assert.rejects(sim.callTool('spoolman', 'record_usage', { id: 1, grams: 10 }), (e: FleetSimError) => e.code === 'approval_required')
  const after = (await sim.callTool('spoolman', 'record_usage', { id: 1, grams: 10 }, sim.permit.mint('inventory', 'spoolman'))) as { remainingG: number }
  assert.equal(after.remainingG, 810)
})

test('camera stills are real JPEGs, as real printers give', async () => {
  const sim = createFleetSim(fixture)
  const withCam = fixture.printers.find((p) => p.cameraAvailable)
  assert.ok(withCam, 'the demo fleet has a printer with a camera')
  const blob = await sim.snapshot(withCam.id)
  assert.ok(blob)
  assert.equal(blob.type, 'image/jpeg')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff])
  assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9])
  assert.ok(bytes.length < 5 * 1024 * 1024)
})
