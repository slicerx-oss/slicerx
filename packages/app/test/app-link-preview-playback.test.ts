// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview, type PreviewBuffers } from '@slicerx/contracts'
import { toolChangerSpec } from '@slicerx/viewport'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { buildTimeline, positionAt } from '../src/lib/preview-timeline'
import { history } from '../src/plate/history'
import { toolStore } from '../src/plate/tools'
import { get, set } from '../src/state/store'
import { playback } from '../src/workspaces/preview/playback'

function preview(layers: [number, number, number][][]): PreviewBuffers {
  const N = layers.length
  const S = layers.reduce((a, l) => a + l.length, 0)
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + (N + 1) * 4 + N * 8 + S * SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, S, true)
  dv.setUint32(12, N, true)
  dv.setUint32(20, 4, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  let first = 0
  layers.forEach((l, k) => {
    dv.setUint32(o + k * 4, first, true)
    first += l.length
  })
  dv.setUint32(o + N * 4, S, true)
  o += (N + 1) * 4
  layers.forEach((_, k) => dv.setFloat32(o + k * 4, 0.2 * (k + 1), true))
  o += N * 4
  layers.forEach((_, k) => dv.setFloat32(o + k * 4, 10, true))
  o += N * 4
  layers.forEach((l, k) => {
    for (const [x0, x1, tool] of l) {
      dv.setFloat32(o, x0, true)
      dv.setFloat32(o + 4, 0, true)
      dv.setFloat32(o + 8, x1, true)
      dv.setFloat32(o + 12, 0, true)
      dv.setFloat32(o + 16, 0.2 * (k + 1), true)
      dv.setUint16(o + 20, 400, true)
      dv.setUint16(o + 22, 200, true)
      dv.setUint8(o + 24, 0)
      dv.setUint8(o + 25, tool)
      dv.setUint16(o + 26, 1000, true)
      o += SXPV_SEGMENT_BYTES
    }
  })
  return readPreview(raw)
}

const frames = new Map<number, FrameRequestCallback>()
let next = 0
let now = 0
let dispose: (() => void) | undefined
const call = (args: Record<string, unknown>) => runCall('preview.playback_set', args)
const sample = () => preview([[[0, 10, 0], [10, 20, 0], [20, 30, 1], [30, 40, 1]], [[40, 50, 1], [50, 60, 2]]])
function bind() {
  const p = sample()
  const changer = toolChangerSpec('snapmaker-u1', { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], machine_tool_change_time: '5', travel_speed: '350' }, { widthMm: 270, depthMm: 270, heightMm: 270 }, 4)!
  const timeline = buildTimeline(p, changer)
  set({ preview: p })
  dispose = playback.bind(p, timeline)
  return { p, timeline }
}
function tick(seconds: number) {
  now += seconds * 1000
  const pending = [...frames.entries()]
  for (const [id, cb] of pending) { frames.delete(id); cb(now) }
}
beforeEach(() => {
  frames.clear(); next = 0; now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = ++next; frames.set(id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  set({ workspace: 'prepare', modelMode: 'slice', sliceLook: 'toolpaths', preview: null, layerHi: 1, moveCut: 0, toolChange: null, playbackSpeed: 1, followNozzle: false })
  toolStore.setState({ tool: 'select' })
})
afterEach(() => { dispose?.(); dispose = undefined; playback.pause(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('reads the same clock and native view position through startup and tool-change seeks', async () => {
  expect(APP_LINK_METHODS['preview.playback']).toBe('read')
  expect(APP_LINK_METHODS['preview.playback_set']).toBe('read')
  expect(await runCall('preview.playback', {})).toMatchObject({ available: false, timeS: null, durationS: null })
  const { p, timeline } = bind()
  const revision = history().state().revision
  const timeS = timeline.changes[0]!.start + 1.25
  await call({ timeS, playing: false, speed: 2, followNozzle: true })
  expect(await runCall('preview.playback', {})).toMatchObject({ available: true, playing: false, timeS, durationS: timeline.total, speed: 2, followNozzle: true, toolChange: { seconds: 1.25 } })
  const expected = positionAt(timeline, p, timeS)
  expect(get()).toMatchObject({ layerHi: expected.layerHi, moveCut: expected.moveCut, toolChange: expected.change })
  expect(history().state().revision).toBe(revision)
})

it('plays from the UI clock, applies speed on the next frame and cancels an already queued tick on pause', async () => {
  bind()
  await call({ timeS: 0, playing: true })
  tick(1)
  expect(playback.read().timeS).toBeCloseTo(1)
  set({ playbackSpeed: 2, followNozzle: true })
  tick(1)
  expect(playback.read()).toMatchObject({ timeS: 3, speed: 2, followNozzle: true, playing: true })
  const stale = [...frames.values()][0]!
  await call({ playing: false })
  stale(now + 1000)
  expect(playback.read()).toMatchObject({ playing: false, timeS: 3 })
  expect(frames.size).toBe(0)
  playback.seek(2)
  expect((await runCall('preview.playback', {}) as { timeS: number }).timeS).toBe(2)
})

it('seeks without pausing, stops at the end, and restarts only when play is requested', async () => {
  const { timeline } = bind()
  await call({ timeS: 0, playing: true })
  await call({ timeS: 2 })
  expect(playback.read().playing).toBe(true)
  tick(0.5)
  expect(playback.read().timeS).toBeCloseTo(2.5)
  await call({ timeS: timeline.total, playing: true })
  expect(playback.read()).toMatchObject({ timeS: 0, playing: true })
  await call({ playing: false, timeS: timeline.total })
  expect(playback.read()).toMatchObject({ timeS: timeline.total, playing: false })
  await call({ playing: true })
  expect(playback.read()).toMatchObject({ timeS: 0, playing: true })
  tick(timeline.total + 10)
  expect(playback.read()).toMatchObject({ timeS: timeline.total, playing: false })
})

it('refuses a whole invalid batch without pausing, seeking or changing preferences', async () => {
  const { timeline } = bind()
  await call({ timeS: 1, playing: true })
  const before = playback.read()
  for (const args of [{}, { playing: false, timeS: timeline.total + 1, speed: 2 }, { playing: false, speed: 3 }, { timeS: NaN }, { timeS: Infinity }, { playing: 'yes' }, { followNozzle: 1 }, { unknown: true }]) {
    await expect(call(args)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(playback.read()).toEqual(before)
  }
  toolStore.setState({ tool: 'paint' })
  await expect(call({ playing: false })).rejects.toMatchObject({ code: 'busy' })
  expect(playback.read()).toEqual(before)
  toolStore.setState({ tool: 'select' })
  set({ modelMode: 'design' })
  await expect(call({ timeS: 0 })).rejects.toMatchObject({ code: 'busy' })
})

it('never advances a replacement slice from an old frame or an old owner cleanup', async () => {
  bind()
  await call({ timeS: 1, playing: true })
  const stale = [...frames.values()][0]!
  const oldDispose = dispose!
  set({ preview: sample(), layerHi: 2, moveCut: 0.4 })
  expect(playback.read()).toMatchObject({ available: false, playing: false, timeS: null })
  await expect(call({ playing: true })).rejects.toMatchObject({ code: 'not_ready' })
  stale(now + 1000)
  expect(get()).toMatchObject({ layerHi: 2, moveCut: 0.4 })
  bind()
  oldDispose()
  expect(playback.read().available).toBe(true)
  dispose!()
  expect(playback.read()).toMatchObject({ available: false, playing: false })
})

it('plays a strike lead-in and stops exactly on the strike even after a late frame', () => {
  const { timeline } = bind()
  const strike = timeline.total - 1
  playback.strike(strike)
  expect(playback.read()).toMatchObject({ playing: true, stopAtS: strike })
  tick(timeline.total)
  expect(playback.read()).toMatchObject({ playing: false, timeS: strike, stopAtS: null })
})

it('reads the exact tool-change time after the Moves slider changes the view independently', async () => {
  const { p, timeline } = bind()
  playback.seek(0)
  const seconds = timeline.changes[0]!.start + 1.25
  const pos = positionAt(timeline, p, seconds)
  set({ layerHi: pos.layerHi, moveCut: pos.moveCut, toolChange: pos.change! })
  expect(await runCall('preview.playback', {})).toMatchObject({ timeS: seconds, toolChange: { seconds: 1.25 } })
})
