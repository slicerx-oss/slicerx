// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  BRANDS,
  CONNECTION_METHODS,
  PRINTER_MODELS,
  brandsWithModels,
  connectionsFor,
  filamentUnitName,
  modelById,
  modelsByConnection,
  preferredConnection,
  searchModels,
} from './index.ts'

const connect = new URL('../../', import.meta.url)
const manifests: { id: string; kind: string }[] = JSON.parse(readFileSync(new URL('manifests.json', connect), 'utf8'))

test('ids are unique and every model names a real brand', () => {
  const ids = PRINTER_MODELS.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length)
  const brands = new Set(BRANDS.map((b) => b.id))
  for (const m of PRINTER_MODELS) assert.ok(brands.has(m.brand), `${m.id} brand ${m.brand}`)
  assert.equal(brandsWithModels().length, BRANDS.length, 'a brand without models should not be listed')
})

test('every model is well formed', () => {
  for (const m of PRINTER_MODELS) {
    assert.ok(m.nozzles.includes(m.defaultNozzle), `${m.id} default nozzle is one of its nozzles`)
    assert.deepEqual([...m.nozzles].sort((a, b) => a - b), m.nozzles, `${m.id} nozzles ascend`)
    assert.ok(m.nozzleCount >= 1)
    const v = m.buildVolume
    if (v.shape === 'circular') assert.ok(v.diameter > 0 && v.z > 0, m.id)
    else assert.ok(v.x > 0 && v.y > 0 && v.z > 0, m.id)
    if (m.kinematics === 'delta') assert.equal(v.shape, 'circular', `${m.id} delta beds are round`)
    if (m.kinematics === 'idex') assert.ok(m.nozzleCount >= 2, m.id)
    if (m.kinematics === 'toolchanger') assert.ok(m.nozzleCount >= 2 && m.filamentSystem === 'toolchanger', m.id)
    assert.ok(m.connections.length > 0)
    assert.equal(new Set(m.connections).size, m.connections.length, `${m.id} lists a connection twice`)
    assert.ok(m.find.ip.length > 0)
    assert.ok(m.find.ip.endsWith('.'), `${m.id} find.ip is a sentence`)
  }
})

test('every model can hand a file to its printer or says how', () => {
  for (const m of PRINTER_MODELS) {
    const last = m.connections[m.connections.length - 1]
    assert.equal(last, 'export', `${m.id} ends with the save G-code fallback`)
    if (m.connections.length === 1) assert.ok(m.note, `${m.id} has no connection and must say why`)
  }
})

test('connection methods match the connector manifests and their guides exist', () => {
  const printerIds = new Set(manifests.filter((m) => m.kind === 'printer').map((m) => m.id))
  for (const c of CONNECTION_METHODS) {
    if (c.plugin) assert.ok(printerIds.has(c.plugin), `${c.id} plugin ${c.plugin}`)
    assert.ok(existsSync(new URL(`docs/${c.guide}`, connect)), `${c.id} guide ${c.guide}`)
    assert.equal(c.fields.some((f) => f.key === 'host'), c.id !== 'export', c.id)
    for (const f of c.fields) if (f.key === 'accessCode' || f.key === 'apiKey' || f.key === 'password') assert.ok(f.secret, `${c.id} ${f.key} is stored as a secret`)
  }
  for (const id of printerIds) assert.ok(CONNECTION_METHODS.some((c) => c.plugin === id), `${id} has a catalog connection`)
  assert.equal(new Set(CONNECTION_METHODS.map((c) => c.id)).size, CONNECTION_METHODS.length)
})

test('start options are listed only for connections that send them', () => {
  const by = Object.fromEntries(CONNECTION_METHODS.map((c) => [c.id, c.startOptions]))
  assert.deepEqual(by['bambu-lan'], ['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse', 'firstLayerInspection'])
  assert.deepEqual(by.elegoo, ['bedLeveling', 'timelapse'])
  for (const id of ['moonraker', 'octoprint', 'prusalink', 'duet', 'creality', 'snapmaker', 'export']) assert.deepEqual(by[id], [], id)
})

test('a model that needs a code or serial says where to read it', () => {
  for (const m of PRINTER_MODELS) {
    const pref = preferredConnection(m)
    if (pref.fields.some((f) => f.key === 'accessCode' && f.required)) {
      assert.ok(m.find.credential, `${m.id} credential`)
      assert.ok(m.find.serial, `${m.id} serial`)
    }
    if (pref.fields.some((f) => f.key === 'apiKey' && f.required)) assert.ok(m.find.credential, `${m.id} credential`)
    if (pref.pairsOnPrinter) assert.ok(m.find.credential, `${m.id} pairing`)
  }
})

test('discovery is listed only where a protocol allows it, and says what it sends', () => {
  const kinds = Object.fromEntries(CONNECTION_METHODS.map((c) => [c.id, c.discovery.kind]))
  assert.deepEqual(kinds, {
    'bambu-lan': 'ssdp',
    moonraker: 'mdns',
    octoprint: 'mdns',
    prusalink: 'mdns',
    duet: 'manual',
    creality: 'manual',
    snapmaker: 'manual',
    elegoo: 'udp-broadcast',
    export: 'manual',
  })
  for (const c of CONNECTION_METHODS) assert.ok(c.discovery.detail.length > 10)
})

test('the demo fleet printers are all in the catalog', () => {
  const fleet = JSON.parse(readFileSync(new URL('fixtures/demo-fleet.json', connect), 'utf8')) as {
    printers: { model: string; plugin: string }[]
  }
  const names = fleet.printers.map((p) => p.model.toLowerCase())
  assert.ok(names.length >= 5)
  for (const p of fleet.printers) {
    const hit = PRINTER_MODELS.find((m) => `${m.name}`.toLowerCase() === p.model.toLowerCase() || p.model.toLowerCase().endsWith(m.name.toLowerCase()))
    assert.ok(hit, `${p.model} is in the catalog`)
    assert.ok(hit.connections.includes(p.plugin as never), `${p.model} can use ${p.plugin}`)
  }
})

test('lookups', () => {
  assert.equal(modelById('bambu-a1')?.name, 'A1')
  assert.equal(modelById('nope'), undefined)
  assert.deepEqual(connectionsFor(modelById('snapmaker-u1')!).map((c) => c.id), ['snapmaker', 'moonraker', 'export'])
  assert.ok(modelsByConnection('bambu-lan').every((m) => m.brand === 'bambu-lab'))
  assert.deepEqual(searchModels('bambu a1').map((m) => m.id), ['bambu-a1', 'bambu-a1-mini'])
  assert.equal(searchModels('').length, PRINTER_MODELS.length)
  for (const kind of ['bed-slinger', 'corexy', 'delta', 'idex'] as const) assert.ok(PRINTER_MODELS.some((m) => m.kinematics === kind), kind)
})

test('the A1 family has an AMS lite, the other Bambu printers an AMS', () => {
  assert.equal(filamentUnitName('A1', 'ams'), 'AMS lite')
  assert.equal(filamentUnitName('A1 mini', 'ams'), 'AMS lite')
  for (const n of ['X1 Carbon', 'P1S', 'H2D']) assert.equal(filamentUnitName(n, 'ams'), 'AMS')
  assert.equal(filamentUnitName('Unlisted', 'mmu'), 'MMU')
})

test('every Bambu Lab model has its SSDP and report code, so a found printer never needs its model picked', () => {
  const file = JSON.parse(readFileSync(new URL('../bambu-model-codes.json', import.meta.url), 'utf8')) as { codes: Record<string, string> }
  const named = new Set(Object.values(file.codes))
  const missing = PRINTER_MODELS.filter((m) => m.brand === 'bambu-lab' && !named.has(m.name)).map((m) => m.name)
  assert.deepEqual(missing, [])
  assert.equal(file.codes['O1D'], 'H2D')
})

test('each Bambu Lab series is told its own way to LAN Only Mode and Developer Mode', () => {
  const find = (id: string) => modelById(id)!.find
  // From Bambu Lab's wiki: X and H2 series Settings, LAN Only; P series Settings, WLAN; A series Settings, page 3.
  for (const id of ['bambu-x1-carbon', 'bambu-x1e', 'bambu-h2d', 'bambu-h2s', 'bambu-p2s']) {
    assert.match(find(id).ip, /Settings, then LAN Only/, id)
    assert.match(find(id).credential!, /LAN Only Liveview/, id)
  }
  for (const id of ['bambu-p1p', 'bambu-p1s']) assert.match(find(id).ip, /Settings, then WLAN/, id)
  for (const id of ['bambu-a1', 'bambu-a1-mini']) assert.match(find(id).credential!, /swipe to page 3 and tap LAN Only Mode/, id)
  for (const m of PRINTER_MODELS.filter((x) => x.brand === 'bambu-lab')) {
    assert.match(m.find.credential!, /Developer Mode \(.*firmware [0-9.]+ and later\)/, m.id)
    assert.doesNotMatch(m.find.credential!, /changes each time/, m.id)
  }
  assert.match(find('bambu-x1-carbon').credential!, /micro SD card/)
})
