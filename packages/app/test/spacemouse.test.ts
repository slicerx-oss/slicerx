// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { DEFAULT_SPACE_MOUSE, EMPTY_REPORT_STATE, type SpaceFrame } from '@slicerx/viewport/spacemouse'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { SpaceMouseSection, spaceMouseStatusText } from '../src/controls/spacemouse-section'
import { loadPrefs, savePrefs } from '../src/state/prefs'
import { appStore, set } from '../src/state/store'
import { connectSpaceMouse, handleSpaceReport, HID_FILTERS, isSpaceMouse, onSpaceMouseFrame, registerSpaceMouseSource, reportBytes, resetSpaceMouseForTests, spaceMouseStatus, startSpaceMouse, webHidSource, type SpaceMouseSource, type SpaceMouseStatus } from '../src/viewport/spacemouse'
import { startSpaceMouseWhenOn } from '../src/viewport/spacemouse-loader'

const MULTI_AXIS = [{ usagePage: 0x01, usage: 0x08 }]

/** A WebHID device that records what is done to it and can send reports. */
class FakeDevice extends EventTarget {
  opened = false
  closed = 0
  constructor(
    readonly vendorId = 0x256f,
    readonly productId = 0xc635,
    readonly productName = 'SpaceMouse Compact',
    readonly collections: { usagePage?: number; usage?: number }[] = MULTI_AXIS,
    private readonly refuse = false,
  ) {
    super()
  }
  async open() {
    if (this.refuse) throw new DOMException('Failed to open the device.', 'NotAllowedError')
    this.opened = true
  }
  async close() {
    this.opened = false
    this.closed++
  }
  send(reportId: number, data: number[]) {
    const e = new Event('inputreport') as Event & { reportId: number; data: DataView; device: FakeDevice }
    Object.assign(e, { reportId, data: new DataView(Uint8Array.from(data).buffer), device: this })
    this.dispatchEvent(e)
  }
}

class FakeHid extends EventTarget {
  requested: unknown[] = []
  constructor(
    public remembered: FakeDevice[] = [],
    public pick: FakeDevice[] = [],
  ) {
    super()
  }
  async getDevices() {
    return this.remembered
  }
  async requestDevice(o: unknown) {
    this.requested.push(o)
    return this.pick
  }
  plug(kind: 'connect' | 'disconnect', d: FakeDevice) {
    const e = new Event(kind) as Event & { device: FakeDevice }
    e.device = d
    this.dispatchEvent(e)
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function collect(src: SpaceMouseSource) {
  const reports: number[][] = []
  const statuses: SpaceMouseStatus[] = []
  const stop = src.start(
    (b) => reports.push([...b]),
    (s) => statuses.push(s),
  )
  return { reports, statuses, stop }
}

describe('3D mouse over WebHID', () => {
  it('is absent where the browser has no WebHID', () => {
    expect(webHidSource({})).toBeNull()
    expect(webHidSource(undefined)).toBeNull()
  })

  it('knows a six axis controller from one of the makers, and nothing else', () => {
    expect(isSpaceMouse(new FakeDevice())).toBe(true)
    expect(isSpaceMouse(new FakeDevice(0x046d, 0xc626))).toBe(true)
    // a Logitech keyboard is not one
    expect(isSpaceMouse(new FakeDevice(0x046d, 0xc31c, 'Keyboard', [{ usagePage: 0x01, usage: 0x06 }]))).toBe(false)
    expect(isSpaceMouse(new FakeDevice(0x1234))).toBe(false)
  })

  it('opens a remembered device on start and passes its reports on with the id first', async () => {
    const d = new FakeDevice()
    const src = webHidSource({ hid: new FakeHid([d]) })!
    const c = collect(src)
    await flush()
    expect(d.opened).toBe(true)
    expect(c.statuses.at(-1)).toEqual({ state: 'connected', name: 'SpaceMouse Compact' })
    d.send(1, [0xaf, 0, 0, 0, 0, 0])
    d.send(3, [1])
    expect(c.reports).toEqual([
      [1, 0xaf, 0, 0, 0, 0, 0],
      [3, 1],
    ])
    c.stop()
    expect(d.closed).toBe(1)
    d.send(1, [0, 0, 0, 0, 0, 0])
    expect(c.reports).toHaveLength(2)
  })

  it('asks for a device with the makers filters only through connect', async () => {
    const d = new FakeDevice()
    const hid = new FakeHid([], [d])
    const src = webHidSource({ hid })!
    const c = collect(src)
    await flush()
    expect(hid.requested).toEqual([])
    expect(c.statuses.at(-1)).toEqual({ state: 'none' })
    await src.connect!()
    expect(hid.requested).toEqual([{ filters: HID_FILTERS }])
    expect(HID_FILTERS).toEqual([
      { vendorId: 0x046d, usagePage: 1, usage: 8 },
      { vendorId: 0x256f, usagePage: 1, usage: 8 },
    ])
    expect(c.statuses.at(-1)).toEqual({ state: 'connected', name: 'SpaceMouse Compact' })
    c.stop()
  })

  it('says the device is held by another program when it cannot be opened', async () => {
    const d = new FakeDevice(0x256f, 0xc635, 'SpaceMouse Compact', MULTI_AXIS, true)
    const c = collect(webHidSource({ hid: new FakeHid([d]) })!)
    await flush()
    expect(c.statuses.at(-1)).toEqual({ state: 'busy', name: 'SpaceMouse Compact' })
    expect(spaceMouseStatusText(c.statuses.at(-1)!, 'webhid')).toMatch(/maker's own driver/)
    c.stop()
  })

  it('follows unplugging and plugging back in', async () => {
    const d = new FakeDevice()
    const hid = new FakeHid([d])
    const c = collect(webHidSource({ hid })!)
    await flush()
    hid.remembered = []
    hid.plug('disconnect', d)
    await flush()
    expect(c.statuses.at(-1)).toEqual({ state: 'none' })
    hid.plug('connect', d)
    await flush()
    expect(c.statuses.at(-1)).toEqual({ state: 'connected', name: 'SpaceMouse Compact' })
    c.stop()
  })

  it('copies the report data from a view into a larger buffer', () => {
    const buf = Uint8Array.from([9, 9, 1, 2, 3, 9]).buffer
    expect([...reportBytes(2, new DataView(buf, 2, 3))]).toEqual([2, 1, 2, 3])
  })
})

describe('3D mouse reports in the app', () => {
  afterEach(() => set({ camera: 'iso' }))

  it('sends motion to the view and button presses to the camera', () => {
    const frames: SpaceFrame[] = []
    const off = onSpaceMouseFrame((f) => frames.push(f))
    let st = handleSpaceReport(Uint8Array.from([1, 0xaf, 0, 0, 0, 0, 0]), EMPTY_REPORT_STATE)
    expect(frames).toEqual([{ tx: 175, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 }])
    set({ camera: 'top' })
    const seq = appStore.getState().cameraSeq
    // the right button fits the view, the left resets it; a release does nothing
    st = handleSpaceReport(Uint8Array.from([3, 2]), st)
    expect(appStore.getState().camera).toBe('fit')
    st = handleSpaceReport(Uint8Array.from([3, 0]), st)
    st = handleSpaceReport(Uint8Array.from([3, 1]), st)
    expect(appStore.getState().camera).toBe('iso')
    expect(appStore.getState().cameraSeq).toBe(seq + 2)
    handleSpaceReport(Uint8Array.from([3, 0]), st)
    expect(appStore.getState().cameraSeq).toBe(seq + 2)
    off()
  })
})

/** A source the test drives: what start was handed, and how often it was started and stopped. */
function fakeSource(kind: 'webhid' | 'desktop' = 'desktop', connect?: () => Promise<void>) {
  const calls = { start: 0, stop: 0 }
  let onReport: (b: Uint8Array) => void = () => {}
  let onStatus: (s: SpaceMouseStatus) => void = () => {}
  const src: SpaceMouseSource = {
    kind,
    start(r, st) {
      calls.start++
      onReport = r
      onStatus = st
      return () => {
        calls.stop++
      }
    },
    ...(connect ? { connect } : {}),
  }
  return { src, calls, report: (b: number[]) => onReport(Uint8Array.from(b)), status: (x: SpaceMouseStatus) => onStatus(x) }
}

describe('3D mouse setting', () => {
  afterEach(() => {
    cleanup()
    resetSpaceMouseForTests()
    registerSpaceMouseSource(null)
    set({ spaceMouse: DEFAULT_SPACE_MOUSE, camera: 'iso' })
  })

  it('renders where no 3D mouse can be reached, without rendering over and over', () => {
    registerSpaceMouseSource(() => null)
    // the status must read as the same value each time, or React renders without end
    expect(spaceMouseStatus()).toBe(spaceMouseStatus())
    render(createElement(SpaceMouseSection))
    expect(screen.getByTestId('space-mouse-status').textContent).toMatch(/Chromium-based browser/)
    expect(screen.getByRole('switch', { name: /Use a 3D mouse/ })).toHaveProperty('disabled', true)
    expect(screen.queryByTestId('space-mouse-connect')).toBeNull()
  })

  it('starts reading at once when the setting was saved on', () => {
    const f = fakeSource()
    registerSpaceMouseSource(() => f.src)
    set({ spaceMouse: { ...DEFAULT_SPACE_MOUSE, enabled: true } })
    startSpaceMouse()
    expect(f.calls.start).toBe(1)
    f.status({ state: 'connected', name: 'SpaceMouse Wireless' })
    expect(spaceMouseStatus()).toEqual({ state: 'connected', name: 'SpaceMouse Wireless' })
  })

  it('loads the reader only once the setting is turned on, and starts it then', async () => {
    const f = fakeSource()
    registerSpaceMouseSource(() => f.src)
    const stopWatch = startSpaceMouseWhenOn()
    await new Promise((r) => setTimeout(r, 0))
    expect(f.calls.start).toBe(0)
    set({ spaceMouse: { ...DEFAULT_SPACE_MOUSE, enabled: true } })
    await vi.waitFor(() => expect(f.calls.start).toBe(1))
    stopWatch()
  })

  it('is saved through the store', () => {
    localStorage.clear()
    set({ spaceMouse: { ...DEFAULT_SPACE_MOUSE, enabled: true, sensitivity: 2, invert: { ...DEFAULT_SPACE_MOUSE.invert, tilt: true } } })
    expect(loadPrefs().spaceMouse).toEqual({ ...DEFAULT_SPACE_MOUSE, enabled: true, sensitivity: 2, invert: { ...DEFAULT_SPACE_MOUSE.invert, tilt: true } })
  })

  it('forgets held buttons when the device goes away, so the first press after it is back counts', () => {
    const f = fakeSource()
    registerSpaceMouseSource(() => f.src)
    set({ spaceMouse: { ...DEFAULT_SPACE_MOUSE, enabled: true } })
    startSpaceMouse()
    f.status({ state: 'connected', name: 'SpaceMouse Wireless' })
    f.report([3, 2])
    expect(appStore.getState().camera).toBe('fit')
    // unplugged with the button held: the release never arrives
    f.status({ state: 'none' })
    set({ camera: 'top' })
    f.status({ state: 'connected', name: 'SpaceMouse Wireless' })
    f.report([3, 2])
    expect(appStore.getState().camera).toBe('fit')
  })

  it('says so when the browser refuses the device, but not when the picker is closed', async () => {
    const refuse = (name: string) => async () => {
      throw Object.assign(new Error(name), { name })
    }
    const closed = fakeSource('webhid', refuse('NotFoundError'))
    registerSpaceMouseSource(() => closed.src)
    await act(() => connectSpaceMouse())
    expect(spaceMouseStatus().state).not.toBe('error')
    resetSpaceMouseForTests()
    set({ spaceMouse: DEFAULT_SPACE_MOUSE })
    const blocked = fakeSource('webhid', refuse('SecurityError'))
    registerSpaceMouseSource(() => blocked.src)
    await act(() => connectSpaceMouse())
    expect(spaceMouseStatus()).toMatchObject({ state: 'error' })
    expect(spaceMouseStatusText(spaceMouseStatus(), 'webhid')).not.toMatch(/SecurityError/)
  })

  beforeEach(() => localStorage.clear())

  it('is kept with the preferences, a bad field falling back on its own', () => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ spaceMouse: { enabled: true, sensitivity: 2.5, invert: { zoom: true, spin: 3 }, dominantAxis: true } }))
    const p = loadPrefs()
    expect(p.spaceMouse).toEqual({ enabled: true, sensitivity: 2.5, invert: { panX: false, panY: false, zoom: true, tilt: false, spin: false }, dominantAxis: true })
    savePrefs(p)
    expect(loadPrefs().spaceMouse).toEqual(p.spaceMouse)
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ spaceMouse: 'on' }))
    expect(loadPrefs().spaceMouse).toBeUndefined()
  })

  it('reads the device only while it is on', async () => {
    const start = vi.fn<SpaceMouseSource['start']>()
    const stop = vi.fn()
    start.mockImplementation((_r, onStatus) => {
      onStatus({ state: 'connected', name: 'SpaceMouse Wireless' })
      return stop
    })
    registerSpaceMouseSource(() => ({ kind: 'desktop', start }))
    set({ spaceMouse: DEFAULT_SPACE_MOUSE })
    startSpaceMouse()
    expect(start).not.toHaveBeenCalled()
    expect(spaceMouseStatus()).toEqual({ state: 'off' })
    set({ spaceMouse: { ...DEFAULT_SPACE_MOUSE, enabled: true } })
    expect(start).toHaveBeenCalledTimes(1)
    expect(spaceMouseStatus()).toEqual({ state: 'connected', name: 'SpaceMouse Wireless' })
    // a speed change keeps the device open
    set({ spaceMouse: { ...DEFAULT_SPACE_MOUSE, enabled: true, sensitivity: 2 } })
    expect(start).toHaveBeenCalledTimes(1)
    set({ spaceMouse: DEFAULT_SPACE_MOUSE })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(spaceMouseStatus()).toEqual({ state: 'off' })
    registerSpaceMouseSource(null)
  })

  it('says so plainly where no 3D mouse can be reached', () => {
    expect(spaceMouseStatusText({ state: 'unsupported' }, null)).toMatch(/Chromium-based browser/)
    expect(spaceMouseStatusText({ state: 'none' }, 'desktop')).toBe('Looking for a 3D mouse. Plug one in.')
  })
})
