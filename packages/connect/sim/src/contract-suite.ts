// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The TS contract suite every PrinterHost implementation must pass. fleet-sim runs it
// today; a host that talks to sx-link runs the same cases against the mock printers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalToken, JobFile, PrinterAction, PrinterEvent, PrinterHost } from '@slicerx/contracts'

export interface HostUnderTest {
  host: PrinterHost
  mint(action: PrinterAction, printerId: string): ApprovalToken
  /** Advance the printer's clock by this many milliseconds. */
  advance(ms: number): void
}

const file = (): JobFile => ({ name: 'contract.gcode', kind: 'gcode', data: new ArrayBuffer(2048), sha256: '00' })

function code(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : 'none'
}

export function runHostContract(label: string, make: () => HostUnderTest): void {
  test(`${label}: lists printers and plugin manifests`, async () => {
    const { host } = make()
    const list = await host.list()
    assert.ok(list.length >= 5)
    const plugins = await host.plugins()
    for (const p of list) assert.ok(plugins.some((m) => m.id === p.plugin), `manifest for ${p.plugin}`)
    for (const m of plugins) {
      for (const t of m.tools) assert.ok(t.name.startsWith(`${m.id}.`), `tool ${t.name} is prefixed`)
    }
  })

  test(`${label}: status is normalized`, async () => {
    const { host } = make()
    const s = await host.status('bay-2')
    assert.equal(s.printerId, 'bay-2')
    assert.ok(['idle', 'preparing', 'printing', 'paused', 'finished', 'error', 'offline'].includes(s.state))
    assert.ok(Array.isArray(s.nozzles) && Array.isArray(s.slots))
  })

  test(`${label}: subscribe delivers a status event and stops after unsubscribe`, async () => {
    const { host } = make()
    const seen: PrinterEvent[] = []
    const off = host.subscribe('bay-1', (e) => seen.push(e))
    await new Promise((r) => setTimeout(r, 5))
    assert.ok(seen.some((e) => e.type === 'status'))
    off()
    const n = seen.length
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(seen.length, n)
  })

  test(`${label}: every side effect refuses a missing token`, async () => {
    const { host } = make()
    const bad = undefined as unknown as ApprovalToken
    const rf = { printerId: 'bay-2', path: 'gcodes/x.gcode', name: 'x.gcode' }
    for (const call of [
      () => host.upload('bay-2', file(), bad),
      () => host.start(rf, {}, bad),
      () => host.pause('bay-1', bad),
      () => host.resume('bay-3', bad),
      () => host.cancel('bay-1', bad),
    ]) {
      await assert.rejects(call, (e) => code(e) === 'approval_required')
    }
  })

  test(`${label}: upload, start, pause, resume, cancel`, async () => {
    const { host, mint, advance } = make()
    const rf = await host.upload('bay-2', file(), mint('upload', 'bay-2'))
    assert.equal(rf.printerId, 'bay-2')
    await host.start(rf, {}, mint('start', 'bay-2'))
    advance(31_000)
    assert.equal((await host.status('bay-2')).state, 'printing')
    await host.pause('bay-2', mint('pause', 'bay-2'))
    assert.equal((await host.status('bay-2')).state, 'paused')
    await host.resume('bay-2', mint('resume', 'bay-2'))
    assert.equal((await host.status('bay-2')).state, 'printing')
    await host.cancel('bay-2', mint('cancel', 'bay-2'))
    assert.equal((await host.status('bay-2')).state, 'idle')
  })

  test(`${label}: an action on the wrong state is bad_state`, async () => {
    const { host, mint } = make()
    await assert.rejects(host.pause('bay-2', mint('pause', 'bay-2')), (e) => code(e) === 'bad_state')
  })

  test(`${label}: an offline printer is unreachable for side effects`, async () => {
    const { host, mint } = make()
    assert.equal((await host.status('bay-5')).state, 'offline')
    await assert.rejects(host.upload('bay-5', file(), mint('upload', 'bay-5')), (e) => code(e) === 'unreachable')
  })

  test(`${label}: snapshot is null without a camera`, async () => {
    const { host } = make()
    assert.equal(await host.snapshot('bay-3'), null)
  })

  test(`${label}: fleets are optional groups of printers`, async () => {
    const { host } = make()
    const printers = await host.list()
    assert.ok(printers.length >= 5, 'every printer is listed whatever fleets exist')
    const before = await host.fleets()

    const bench = await host.createFleet('  Bench  ', { color: 'cyan', printerIds: ['bay-1', 'bay-1'] })
    assert.equal(bench.name, 'Bench')
    assert.deepEqual(bench.printerIds, ['bay-1'])
    assert.equal(bench.color, 'cyan')

    // A printer can be in several fleets, adding twice changes nothing.
    const other = await host.createFleet('Enclosed')
    await host.addToFleet(other.id, 'bay-1')
    const again = await host.addToFleet(other.id, 'bay-1')
    assert.deepEqual(again.printerIds, ['bay-1'])
    assert.deepEqual((await host.addToFleet(bench.id, 'bay-2')).printerIds, ['bay-1', 'bay-2'])
    assert.deepEqual((await host.removeFromFleet(bench.id, 'bay-1')).printerIds, ['bay-2'])
    assert.equal((await host.fleets()).find((f) => f.id === other.id)?.printerIds.includes('bay-1'), true)

    // Rename, update, and the validation rules.
    assert.equal((await host.renameFleet(bench.id, 'Back bench')).name, 'Back bench')
    const styled = await host.updateFleet(bench.id, { icon: 'printer', color: null })
    assert.equal(styled.icon, 'printer')
    assert.equal(styled.color, undefined)
    await assert.rejects(host.createFleet('   '), (e) => code(e) === 'protocol')
    await assert.rejects(host.createFleet('ENCLOSED'), (e) => code(e) === 'protocol')
    await assert.rejects(host.renameFleet(bench.id, 'enclosed'), (e) => code(e) === 'protocol')
    await assert.rejects(host.addToFleet(bench.id, 'no-such-printer'), (e) => code(e) === 'not_found')
    await assert.rejects(host.createFleet('Ghosts', { printerIds: ['no-such-printer'] }), (e) => code(e) === 'not_found')
    await assert.rejects(host.addToFleet('nope', 'bay-1'), (e) => code(e) === 'not_found')

    // Deleting a fleet never deletes printers.
    await host.deleteFleet(bench.id)
    await host.deleteFleet(other.id)
    await assert.rejects(host.deleteFleet(other.id), (e) => code(e) === 'not_found')
    assert.deepEqual((await host.fleets()).map((f) => f.id), before.map((f) => f.id))
    assert.equal((await host.list()).length, printers.length)
  })
}
