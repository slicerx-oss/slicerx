// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it, vi } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { bedKnownClear, deviceError, deviceHub, filamentText, jogBlockedReason, messageTone, plateObjectsFromGcode, recordDuration, SEVERITY_LABEL, splitIssues, startBlockedReason, startStored, type DeviceHub } from '../src/features/fleet/device'

const refuse = (code: string) => Object.assign(new Error(`hub says ${code}`), { code })

function hub(over: Partial<DeviceHub['device']> = {}, askOnPrint = true): DeviceHub {
  return {
    device: { files: async () => [], history: async () => [], issues: async () => [], objects: async () => [], jog: async () => undefined, skipObject: async () => undefined, startFile: async () => ({ started: true }), ...over },
    bed: { state: async () => ({ askOnPrint }) },
  }
}

describe('device page rules', () => {
  it('moves the head only when idle, and says why not', () => {
    expect(jogBlockedReason('idle')).toBeNull()
    expect(jogBlockedReason('finished')).toBeNull()
    for (const s of ['printing', 'paused', 'preparing'] as const) expect(jogBlockedReason(s)).toMatch(/idle/)
    expect(jogBlockedReason('offline')).toMatch(/not reachable/)
    expect(jogBlockedReason('error')).toMatch(/error/)
    expect(startBlockedReason('printing')).toBe('The printer is busy.')
    expect(startBlockedReason('idle')).toBeNull()
  })

  it('finds a hub only when the host has the device methods', () => {
    expect(deviceHub({} as Host)).toBeNull()
    expect(deviceHub({ printers: { list: async () => [] } } as unknown as Host)).toBeNull()
    expect(deviceHub({ printers: hub() } as unknown as Host)).not.toBeNull()
  })

  it('explains hub refusals in plain words', () => {
    expect(deviceError(refuse('forbidden'))).toMatch(/own network/)
    expect(deviceError(refuse('not_supported'))).toMatch(/own network/)
    expect(deviceError(new Error('a jog is 0.1 to 10 mm either way'))).toBe('a jog is 0.1 to 10 mm either way')
    expect(recordDuration(42)).toBe('42 s')
    expect(recordDuration(5400)).toBe('1 h 30 min')
    expect(recordDuration(undefined)).toBe('')
    expect(filamentText(4200)).toBe('4.2 m of filament')
  })
})

describe('starting a stored file', () => {
  it('asks the bed question first, then the unverified one, then starts', async () => {
    const calls: unknown[] = []
    const startFile = vi.fn(async (_id: string, _path: string, o?: { bedClear?: boolean; unverifiedOk?: boolean }) => {
      calls.push(o)
      if (!o?.bedClear) throw refuse('bed_check')
      if (!o.unverifiedOk) throw refuse('unverified_file')
      return { started: true }
    })
    const h = hub({ startFile })
    expect(await startStored(h, 'bay', 'a.gcode', { bedClear: false, unverifiedOk: false })).toEqual({ kind: 'ask-bed' })
    expect(await startStored(h, 'bay', 'a.gcode', { bedClear: true, unverifiedOk: false })).toEqual({ kind: 'ask-unverified' })
    expect(await startStored(h, 'bay', 'a.gcode', { bedClear: true, unverifiedOk: true })).toEqual({ kind: 'started' })
    expect(calls).toEqual([{}, { bedClear: true }, { bedClear: true, unverifiedOk: true }])
  })

  it('passes other refusals through and reads the bed rule from the hub', async () => {
    const h = hub({ startFile: async () => { throw refuse('busy') } })
    expect(await startStored(h, 'bay', 'a.gcode', { bedClear: true, unverifiedOk: true })).toEqual({ kind: 'error', message: 'hub says busy' })
    expect(await bedKnownClear(hub({}, false), 'bay')).toBe(true)
    expect(await bedKnownClear(hub({}, true), 'bay')).toBe(false)
  })
})

describe('skipping on printers that cannot list objects', () => {
  it('reads the labeled objects of a Bambu Lab file with the area each covers', () => {
    const g = [
      '; printing object bracket.stl_id_0_copy_0 id:0 copy 0',
      '; start printing object, unique label id: 0',
      'M624 AAAAAAAAAAA=',
      'G1 X10 Y10',
      'G1 X30 Y10 E1.2',
      'G1 X30 Y25 E0.8 ; wall',
      '; stop printing object, unique label id: 0',
      'M625',
      'G0 X100 Y100',
      '; start printing object, unique label id: 1',
      'G1 X110 Y100 E1',
      'G1 X200 Y200',
      '; stop printing object, unique label id: 1',
    ].join('\n')
    const o = plateObjectsFromGcode(g)
    expect(o.map((x) => [x.id, x.name])).toEqual([['0', 'bracket'], ['1', 'Object 2']])
    expect(o[0]!.polygon).toEqual([[10, 10], [30, 10], [30, 25], [10, 25]])
    expect(o[1]!.polygon[2]).toEqual([110, 100])
    expect(plateObjectsFromGcode('G1 X1 Y1 E1')).toEqual([])
  })

  it('reads the ids of a file from the engine, which count from 1 and are listed in the header', () => {
    const g = [
      '; model label id: 1,2',
      '; printing object bracket id:1 copy 0',
      '; start printing object, unique label id: 1',
      'M624 AQAAAAAAAAA=',
      'G1 X10 Y10',
      'G1 X30 Y25 E0.8',
      '; stop printing object, unique label id: 1',
      'M625',
      '; object ids of layer 2 start: 1,2',
      'M624 AwAAAAAAAAA=',
      '; start printing object, unique label id: 2',
      'M624 AgAAAAAAAAA=',
      'G0 X110 Y100',
      'G1 X120 Y100 E1',
      'G1 X200 Y200 E1',
      '; stop printing object, unique label id: 2',
      'M625',
      '; object ids of this layer2 end: 1,2',
      'M625',
    ].join('\n')
    const o = plateObjectsFromGcode(g)
    expect(o.map((x) => [x.id, x.name])).toEqual([['1', 'bracket'], ['2', 'Object 2']])
    expect(o[1]!.polygon).toEqual([[110, 100], [200, 100], [200, 200], [110, 200]])
  })

  it('says why a skip was refused', () => {
    expect(deviceError(Object.assign(new Error("this print was not sent from SlicerX, so its objects are unknown here; skip them on the printer's screen"), { code: 'not_supported' }))).toMatch(/^This print was not sent from SlicerX.*screen\.$/)
    expect(deviceError(refuse('job_changed'))).toMatch(/Another print started/)
  })
})

describe('printer messages on a finished job', () => {
  it('reads a message as a live problem only while a job runs, is paused or failed', () => {
    for (const s of ['printing', 'paused', 'preparing', 'error'] as const) expect(messageTone(s)).toBe('warn')
    for (const s of ['finished', 'idle', 'offline'] as const) expect(messageTone(s)).toBe('muted')
  })

  it('keeps a code left over from the last job apart from the current ones', () => {
    const leftover = { code: '0500_0500_0001_0007', severity: 'fatal' as const, module: 'main board', text: 'The main board reported a fatal error.', stale: true }
    const now = { code: '0700_2000_0003_0001', severity: 'common' as const, module: 'AMS', text: 'AMS A needs attention.' }
    expect(splitIssues([leftover, now])).toEqual({ now: [now], earlier: [leftover] })
    expect(SEVERITY_LABEL.fatal).not.toMatch(/stopped/i)
  })
})
