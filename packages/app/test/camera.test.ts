// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { adapt, DOWN_AFTER, initialAdapt, UP_AFTER } from '../src/camera/adaptive'
import { QUALITY_SPEC, snapshotSession, stubStreams, type StreamStats } from '../src/camera/stream'

const smooth = (fps: number): StreamStats => ({ fps, latencyMs: 80, kbps: 1000 })
const laggy = (fps: number): StreamStats => ({ fps, latencyMs: 1500, kbps: 1000 })

function run(start: 'low' | 'medium' | 'high', seconds: StreamStats[], supported?: readonly ('low' | 'medium' | 'high')[]) {
  let s = initialAdapt(start)
  for (const x of seconds) s = adapt(s, x, supported)
  return s
}

describe('adaptive quality', () => {
  it('steps down after sustained trouble, not one bad second', () => {
    expect(run('high', [smooth(5)]).quality).toBe('high')
    expect(run('high', Array(DOWN_AFTER).fill(smooth(5))).quality).toBe('medium')
    expect(run('medium', Array(DOWN_AFTER).fill(laggy(15))).quality).toBe('low')
  })

  it('steps up only after a long smooth run', () => {
    expect(run('low', Array(UP_AFTER - 1).fill(smooth(QUALITY_SPEC.low.fps))).quality).toBe('low')
    expect(run('low', Array(UP_AFTER).fill(smooth(QUALITY_SPEC.low.fps))).quality).toBe('medium')
  })

  it('does not go past the ends or the camera supported levels', () => {
    expect(run('low', Array(20).fill(laggy(1))).quality).toBe('low')
    expect(run('medium', Array(40).fill(smooth(15)), ['low', 'medium']).quality).toBe('medium')
  })

  it('resets the count when a bad second breaks a good run', () => {
    const seconds = [...Array(UP_AFTER - 1).fill(smooth(10)), smooth(2), ...Array(UP_AFTER - 1).fill(smooth(10))]
    expect(run('low', seconds).quality).toBe('low')
  })
})

describe('stand-in streams', () => {
  it('falls back to snapshots where the browser cannot capture a canvas', async () => {
    const s = await stubStreams().open({ id: 'p', name: 'Bay 1' }, { quality: 'medium' })
    expect(s.mode).toBe('snapshot')
    expect(s.media).toBeNull()
    s.close()
  })

  it('a snapshot session asks the connector for stills', async () => {
    const blob = new Blob(['x'])
    const host = { printers: { snapshot: async (id: string) => (id === 'p' ? blob : null) } } as never
    expect(await snapshotSession(host, { id: 'p', name: 'Bay 1' }).snapshot!()).toBe(blob)
    expect(await snapshotSession(undefined, { id: 'p', name: 'Bay 1' }).snapshot!()).toBeNull()
  })
})
