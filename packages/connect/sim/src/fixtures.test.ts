// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The JSON the Rust crate writes to packages/contracts/fixtures/printers-*.json parses as the
// TS contract types. Rust owns the files (tests/contract_json.rs in sx-connect).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { DiscoveredPrinter, PrinterConfig, PrinterEvent, PrinterStatus, RemoteFile, StartOptions } from '@slicerx/contracts'

const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${name}`, import.meta.url), 'utf8')) as T

test('printers-status.json matches PrinterStatus', () => {
  const s = load<PrinterStatus>('printers-status.json')
  const states = ['idle', 'preparing', 'printing', 'paused', 'finished', 'error', 'offline']
  assert.ok(states.includes(s.state))
  assert.equal(typeof s.printerId, 'string')
  assert.ok(Array.isArray(s.nozzles) && s.nozzles.every((n) => typeof n.current === 'number' && typeof n.target === 'number'))
  assert.equal(typeof s.cameraAvailable, 'boolean')
  assert.ok(s.slots.every((slot) => typeof slot.id === 'string'))
  assert.ok(!Number.isNaN(Date.parse(s.updatedAt)))
})

test('printers-status-h2d.json carries what the device view reads', () => {
  const s = load<PrinterStatus>('printers-status-h2d.json')
  assert.equal(s.nozzles.length, s.live?.nozzleSides?.length)
  assert.ok(s.live?.nozzleSides?.every((x) => x === 'left' || x === 'right'))
  assert.ok(s.slots.some((slot) => slot.id === s.live?.activeSlot))
  assert.ok(s.live?.units?.every((u) => s.slots.some((slot) => slot.id.startsWith(u.id))))
  for (const v of Object.values(s.live?.fans ?? {})) assert.ok(typeof v === 'number' && v >= 0 && v <= 100)
  assert.equal(typeof s.live?.speedPercent, 'number')
})

test('printers-events.json matches PrinterEvent', () => {
  const events = load<PrinterEvent[]>('printers-events.json')
  assert.deepEqual(events.map((e) => e.type), ['status', 'job_finished', 'error'])
  for (const e of events) {
    if (e.type === 'job_finished') assert.equal(typeof e.ok, 'boolean')
    if (e.type === 'error') assert.equal(typeof e.code, 'string')
  }
})

test('printers-config.json matches the config shapes', () => {
  const b = load<{ config: PrinterConfig; discovered: DiscoveredPrinter; remote: RemoteFile; start: StartOptions }>('printers-config.json')
  assert.equal(b.config.plugin, 'bambu-lan')
  assert.equal(typeof b.discovered.host, 'string')
  assert.equal(b.remote.printerId, 'bay-2')
  assert.deepEqual(b.start.slotMap, { 0: 'A1', 2: 'A3' })
})
