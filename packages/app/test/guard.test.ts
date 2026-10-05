// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { guardedPrinters } from '../src/plate/guard'
import { get, set } from '../src/state/store'

const info: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1 }
const idle: PrinterStatus = { printerId: 'bay-2', state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: '' }

function fake() {
  const calls: string[] = []
  const printers = {
    list: async () => [info],
    status: async () => idle,
    upload: async (id: string, f: { name: string }) => { calls.push(`upload ${f.name}`); return { printerId: id, path: `/${f.name}`, name: f.name } },
    start: async (f: { name: string }) => void calls.push(`start ${f.name}`),
    resume: async (id: string) => void calls.push(`resume ${id}`),
  } as unknown as PrinterHost
  return { calls, guarded: guardedPrinters({ printers })! }
}

/**
 * Waits for the card, then answers it. The card comes after the guard's own async work (the printer list, the preflight
 * module loading the first time), so the wait is generous: a slow machine must not fail a guard that is behaving.
 */
async function answer(approve: boolean): Promise<void> {
  const until = Date.now() + 15_000
  while (!get().approval && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
  const a = get().approval
  if (!a) throw new Error('no card')
  expect(a.confirm).toBeTruthy()
  await (approve ? a.approve() : a.deny())
}

describe('mimir printer calls go through the card', () => {
  it('upload shows the preflight and bed-clear card; start after it does not ask again', async () => {
    set({ approval: null, plate: [], slice: { status: 'idle' } })
    const { calls, guarded } = fake()
    const file = { name: 'a.gcode', kind: 'gcode' as const, data: new ArrayBuffer(0), sha256: 'ab'.repeat(32) }
    const up = guarded.upload('bay-2', file, 'tok' as never)
    await answer(true)
    const remote = await up
    expect(get().approval?.checks).toBeUndefined()
    await guarded.start(remote, {}, 'tok' as never)
    expect(get().approval).toBeNull()
    expect(calls).toEqual(['upload a.gcode', 'start a.gcode'])
  })

  it('a no on the card sends nothing', async () => {
    set({ approval: null })
    const { calls, guarded } = fake()
    const up = guarded.upload('bay-2', { name: 'b.gcode', kind: 'gcode', data: new ArrayBuffer(0), sha256: 'cd'.repeat(32) }, 'tok' as never)
    await answer(false)
    await expect(up).rejects.toThrow(/Nothing was sent/)
    const res = guarded.resume('bay-2', 'tok' as never)
    await answer(false)
    await expect(res).rejects.toThrow()
    expect(calls).toEqual([])
  })
})
