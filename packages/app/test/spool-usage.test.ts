// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { forgetPending, jobKey, PENDING_MAX_AGE_MS, pendingUses, rememberUse, takePending, usesFor, watchFinishedPrints } from '../src/inventory/usage'
import type { Spool } from '../src/inventory/spools'

const spool = (id: number): Spool => ({ id, material: 'PLA', vendor: 'Acme', name: `Red ${id}`, color: '#f00', remainingG: 500, initialG: 1000 })
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
})

describe('spool use from a finished print', () => {
  it('adds up per linked spool and skips unlinked slots', () => {
    const uses = usesFor([12.34, 5, 0], [spool(1), spool(2)], { 1: 1 }, [undefined, 2, undefined])
    expect(uses).toEqual([{ spoolId: 1, label: 'Acme Red 1', grams: 12.3 }, { spoolId: 2, label: 'Acme Red 2', grams: 5 }])
    expect(usesFor([0], [spool(1)], { 1: 1 })).toEqual([])
  })

  it('matches the printer job name however the extension is spelled', () => {
    expect(jobKey('Harbor lantern.gcode.3mf')).toBe('harbor lantern')
    rememberUse({ printerId: 'bay', jobName: 'Harbor lantern.gcode', uses: [{ spoolId: 1, label: 'x', grams: 3 }] })
    expect(takePending('bay', 'harbor lantern')?.uses[0]?.grams).toBe(3)
    expect(pendingUses()).toEqual([])
  })

  it('keeps nothing without linked spools, one plate per printer, and drops old ones', () => {
    rememberUse({ printerId: 'bay', jobName: 'a.gcode', uses: [] })
    expect(pendingUses()).toEqual([])
    rememberUse({ printerId: 'bay', jobName: 'a.gcode', uses: [{ spoolId: 1, label: 'x', grams: 1 }] }, 0)
    rememberUse({ printerId: 'bay', jobName: 'b.gcode', uses: [{ spoolId: 1, label: 'x', grams: 2 }] }, 10)
    expect(pendingUses().map((p) => p.jobName)).toEqual(['b.gcode'])
    expect(takePending('bay', 'b.gcode', 10 + PENDING_MAX_AGE_MS + 1)).toBeNull()
  })

  it('records on finished, forgets on failed or canceled, and ignores other printers', () => {
    let cb: ((a: { printerId: string; kind: string; jobName?: string }) => void) | null = null
    const host = { printers: { onAlert: (f: typeof cb) => ((cb = f), () => undefined) } } as unknown as Host
    const record = vi.fn(async () => undefined)
    watchFinishedPrints(host, record)
    rememberUse({ printerId: 'bay', jobName: 'a.gcode', uses: [{ spoolId: 1, label: 'x', grams: 4 }] })
    cb!({ printerId: 'other', kind: 'finished', jobName: 'a.gcode' })
    expect(record).not.toHaveBeenCalled()
    cb!({ printerId: 'bay', kind: 'finished', jobName: 'other job' })
    expect(record).not.toHaveBeenCalled()
    cb!({ printerId: 'bay', kind: 'finished', jobName: 'a' })
    expect(record).toHaveBeenCalledWith(host, [{ spoolId: 1, label: 'x', grams: 4 }])
    expect(pendingUses()).toEqual([])
    rememberUse({ printerId: 'bay', jobName: 'c.gcode', uses: [{ spoolId: 1, label: 'x', grams: 4 }] })
    cb!({ printerId: 'bay', kind: 'canceled', jobName: 'c.gcode' })
    expect(pendingUses()).toEqual([])
    forgetPending('bay')
    expect(watchFinishedPrints({} as Host, record)()).toBeUndefined()
  })
})
