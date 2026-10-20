// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// New conversation in the mimir tab ends the old chat: the runtime drops that chat's print run, so a record never
// outlives its chat, and the new chat starts with its own id. A print the old chat started is still watched to its end,
// and the end line lands in the old chat's log.
import type { Host, MeshHandle, MeshPart, Pilot, PrinterEvent, PrinterHost } from '@slicerx/contracts'
import { runBookFor } from '@slicerx/pilot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEUTRAL } from '../src/edition'
import { get, set } from '../src/state/store'
import { appPrintRun } from '../src/workspaces/mimir/print-run'
import { mimirLogs, resetTabMimir, startNewChat, tabMimir } from '../src/workspaces/mimir/session'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const host = { kind: 'desktop', capabilities: { secureStorage: true }, slicer: loader, build: { version: '0.0.0-test' } } as unknown as Host

describe('a new conversation in the mimir tab', () => {
  const was = { pilot: get().pilot }
  beforeEach(() => resetTabMimir())
  afterEach(() => {
    resetTabMimir()
    set(was)
  })

  it("drops the old chat's print run and gives the new chat its own id", async () => {
    set({ pilot: { mode: 'unset' } })
    const pilot = (await tabMimir(host, NEUTRAL)) as unknown as { forgetRun: (id: string) => void }
    const forget = vi.spyOn(pilot, 'forgetRun')
    const next = startNewChat('mimir_old')
    expect(forget).toHaveBeenCalledTimes(1)
    expect(forget).toHaveBeenCalledWith('mimir_old')
    expect(next).toMatch(/^mimir_/)
    expect(next).not.toBe('mimir_old')
  })

  it('keeps watching a running print, and its end line lands in the old chat', async () => {
    set({ pilot: { mode: 'unset' } })
    const subs = new Set<(e: PrinterEvent) => void>()
    const printers = {
      list: async () => [{ id: 'p1', name: 'Bench', vendor: 'Prusa', model: 'MK4', plugin: 'prusalink', nozzleCount: 1 }],
      plugins: async () => [],
      subscribe: (_id: string, fn: (e: PrinterEvent) => void) => {
        subs.add(fn)
        return () => void subs.delete(fn)
      },
    } as unknown as PrinterHost
    const pilot = (await tabMimir({ ...host, printers } as unknown as Host, NEUTRAL)) as Pilot
    // the print the old chat started, as printer.queue records it
    runBookFor(appPrintRun(), Date.now).recordJob('mimir_watch', { printerId: 'p1', fileName: 'clip.gcode', startedAt: new Date().toISOString(), state: 'printing' })
    expect(subs.size).toBe(1)
    startNewChat('mimir_watch')
    // the chat's run is gone from view, and the watch goes on
    expect(pilot.printRun?.('mimir_watch')?.job).toBeNull()
    expect(subs.size).toBe(1)
    for (const fn of [...subs]) fn({ type: 'job_finished', printerId: 'p1', jobName: 'clip', ok: true })
    expect(subs.size).toBe(0)
    const lines = async () => (await mimirLogs.read('mimir_watch')).flatMap((e) => (e.type === 'run_note' ? [e.text] : []))
    await vi.waitFor(async () => expect(await lines()).toEqual(['clip.gcode finished on Bench.']))
    // and the run that ended does not come back into view
    expect(pilot.printRun?.('mimir_watch')?.job).toBeNull()
  })

  it('has nothing to drop before the tab has set up its runtime', () => {
    expect(() => startNewChat('mimir_old')).not.toThrow()
  })
})
