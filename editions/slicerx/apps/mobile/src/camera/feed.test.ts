// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fmtEta } from '../components/printers/printer-bits'
import { modeLabel } from '../components/printers/live-view'
import { parsePushData, pushHref, PUSH_TEXT, wantsPush } from '../notify/push'
import { pairedFeeds, stillsFeeds, type FeedFrame, type PairedCamera, type PairedCameraFrame, type PairedCameraStats } from './feed'

/** Runs the stills timers by hand. */
function clock() {
  let t = 1_000_000
  const timers: { at: number; fn: () => void; id: number }[] = []
  let next = 1
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++
      timers.push({ at: t + ms, fn, id })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (id: ReturnType<typeof setTimeout>) => {
      const i = timers.findIndex((x) => x.id === (id as unknown as number))
      if (i >= 0) timers.splice(i, 1)
    },
    async advance(ms: number) {
      const until = t + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const first = timers[0]
        if (!first || first.at > until) break
        timers.shift()
        t = first.at
        first.fn()
        await Promise.resolve()
        await Promise.resolve()
      }
      t = until
    },
  }
}

it('polls stills at the pace of the quality and ends after three misses', async () => {
  const c = clock()
  let n = 0
  let fail = false
  const snapshot = jest.fn(async () => (fail ? null : `data:image/jpeg;base64,${n++}`))
  const feeds = stillsFeeds(snapshot, c)
  const feed = await feeds.open('bay-1', { quality: 'high' })
  const frames: FeedFrame[] = []
  let ended = false
  feed.onFrame((f) => frames.push(f))
  feed.onEnded(() => (ended = true))
  expect(feed.mode).toBe('stills')
  await c.advance(0)
  expect(frames).toHaveLength(1)
  await c.advance(1600)
  expect(frames.length).toBeGreaterThanOrEqual(3)
  fail = true
  await c.advance(2000)
  expect(ended).toBe(true)
  feed.close()
})

it('rejects a printer without a camera', async () => {
  const feeds = stillsFeeds(async () => null)
  await expect(feeds.open('bay-3', { quality: 'low' })).rejects.toThrow('No camera on this printer')
})

it('turns paired camera frames into image URIs and reports frames per second', async () => {
  const frames = new Set<(f: PairedCameraFrame) => void>()
  const stats = new Set<(s: PairedCameraStats) => void>()
  const camera: PairedCamera = {
    open: jest.fn(async () => ({ stream: 7, quality: 'medium' as const })),
    setQuality: jest.fn(async (_s, quality) => ({ quality })),
    close: jest.fn(async () => undefined),
    onFrame: (cb) => {
      frames.add(cb)
      return () => frames.delete(cb)
    },
    onStats: (cb) => {
      stats.add(cb)
      return () => stats.delete(cb)
    },
    onEnded: () => () => undefined,
  }
  const feed = await pairedFeeds(camera).open('bay-1', { quality: 'medium' })
  const got: FeedFrame[] = []
  feed.onFrame((f) => got.push(f))
  const seen: number[] = []
  feed.onStats((s) => seen.push(s.fps))
  for (const cb of frames) cb({ stream: 7, capturedAt: 5, key: true, kind: 'jpeg', dataB64: 'AAAA' })
  for (const cb of frames) cb({ stream: 8, capturedAt: 5, key: true, kind: 'jpeg', dataB64: 'BBBB' })
  expect(got).toEqual([{ uri: 'data:image/jpeg;base64,AAAA', at: 5 }])
  for (const cb of stats) cb({ stream: 7, fps: 10, kbps: 500, dropped: 0, quality: 'medium' })
  expect(seen).toHaveLength(1)
  await feed.setQuality('low')
  expect(feed.quality).toBe('low')
  feed.close()
  feed.close()
  expect(camera.close).toHaveBeenCalledTimes(1)
})

it('labels how the picture arrives', () => {
  expect(modeLabel({ mode: 'live', stats: { fps: 12, kbps: 1, quality: 'high' }, stale: false })).toBe('Live, 12 fps')
  expect(modeLabel({ mode: 'stills', stats: null, stale: false })).toBe('Stills')
  expect(modeLabel({ mode: 'live', stats: null, stale: true })).toBe('No picture')
})

it('says when a print is done', () => {
  const now = new Date(2026, 8, 30, 14, 5).getTime()
  expect(fmtEta(5040, now)).toBe('Done by 15:29')
  expect(fmtEta(12 * 3600, now)).toBe('Done tomorrow 02:05')
  expect(fmtEta(3 * 86_400, now)).toBe('Done in 3 days')
})

it('reads push data and keeps the visible text free of names', () => {
  expect(parsePushData({ kind: 'attention', printerId: 'bay-3' })).toEqual({ kind: 'attention', printerId: 'bay-3' })
  expect(parsePushData({ kind: 'nope' })).toBeNull()
  expect(parsePushData({ kind: 'approval', href: 'https://evil.example' })).toEqual({ kind: 'approval' })
  expect(pushHref({ kind: 'print_done', printerId: 'bay-1' })).toBe('/printer/bay-1')
  expect(pushHref({ kind: 'approval' })).toBe('/(tabs)')
  for (const text of Object.values(PUSH_TEXT)) expect(`${text.title} ${text.body}`).not.toMatch(/Bay|\.gcode|\.3mf/)
  expect(wantsPush({ printDone: false, printFailed: false, attention: false, approvals: false })).toBe(false)
})
