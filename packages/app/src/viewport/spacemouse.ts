// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D mouse device: finds it, reads its reports and hands them on. In the browser it is WebHID (Chromium-based
// browsers): access is asked for once from the Connect button, and later loads find the same device again through
// getDevices. The desktop shell registers its own reader (the web view there has no WebHID on macOS or Linux), which
// sends the same raw reports. Motion goes to the 3D view (viewport-host.tsx, spaceMouseInput); the first button resets
// the view and the second fits it. Everything here runs only while Settings > Controls > 3D mouse is on, and the module
// itself loads only then (app.tsx) or from the Connect button; what loads with the app is spacemouse-state.ts.
import { EMPTY_REPORT_STATE, parseSpaceReportBytes, spaceButtonPresses, SPACE_MOUSE_USAGE, SPACE_MOUSE_VENDORS, type SpaceReportState } from '@slicerx/viewport/spacemouse'
import { appStore, set, setCamera } from '../state/store'
import {
  emitSpaceFrame,
  registeredSpaceMouseSource,
  resetSpaceMouseStateForTests,
  setSpaceMouseStatus,
  SPACE_MOUSE_OFF,
  type SpaceMouseSource,
  type SpaceMouseStatus,
} from './spacemouse-state'

export { onSpaceMouseFrame, registerSpaceMouseSource, spaceMouseStatus, subscribeSpaceMouseStatus, type SpaceMouseSource, type SpaceMouseStatus } from './spacemouse-state'

// ---------- WebHID ----------

/** The part of WebHID used here; the DOM types this repo builds with do not include it. */
interface HidDeviceLike extends EventTarget {
  readonly opened: boolean
  readonly vendorId: number
  readonly productId: number
  readonly productName: string
  readonly collections: readonly { usagePage?: number; usage?: number }[]
  open(): Promise<void>
  close(): Promise<void>
}
interface HidInputReportEventLike extends Event {
  readonly device: HidDeviceLike
  readonly reportId: number
  readonly data: DataView
}
interface HidLike extends EventTarget {
  getDevices(): Promise<HidDeviceLike[]>
  requestDevice(o: { filters: { vendorId?: number; usagePage?: number; usage?: number }[] }): Promise<HidDeviceLike[]>
}

export const HID_FILTERS = SPACE_MOUSE_VENDORS.map((vendorId) => ({ vendorId, ...SPACE_MOUSE_USAGE }))

/** A six axis controller from one of the makers' vendor ids. */
export function isSpaceMouse(d: Pick<HidDeviceLike, 'vendorId' | 'collections'>): boolean {
  return SPACE_MOUSE_VENDORS.includes(d.vendorId) && d.collections.some((c) => c.usagePage === SPACE_MOUSE_USAGE.usagePage && c.usage === SPACE_MOUSE_USAGE.usage)
}

/** The report as one array: its id, then its bytes. */
export function reportBytes(reportId: number, data: DataView): Uint8Array {
  const out = new Uint8Array(data.byteLength + 1)
  out[0] = reportId
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 1)
  return out
}

function hidOf(nav: unknown): HidLike | null {
  const hid = (nav as { hid?: unknown } | undefined)?.hid
  return hid && typeof (hid as HidLike).getDevices === 'function' ? (hid as HidLike) : null
}

/** WebHID, or null where the browser has none (Firefox, Safari, the macOS and Linux web views). */
export function webHidSource(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): SpaceMouseSource | null {
  const hid = hidOf(nav)
  if (!hid) return null
  let attach: ((d: HidDeviceLike) => Promise<void>) | null = null
  return {
    kind: 'webhid',
    start(onReport, onStatus) {
      let current: HidDeviceLike | null = null
      let stopped = false
      const onInput = (e: Event) => {
        const r = e as HidInputReportEventLike
        onReport(reportBytes(r.reportId, r.data))
      }
      attach = async (d) => {
        if (stopped || current === d) return
        try {
          if (!d.opened) await d.open()
        } catch {
          // Chromium refuses to open a device another program holds on to (the maker's driver on some systems).
          onStatus({ state: 'busy', name: d.productName })
          return
        }
        if (stopped) return void d.close().catch(() => {})
        current = d
        d.addEventListener('inputreport', onInput)
        onStatus({ state: 'connected', name: d.productName || '3D mouse' })
      }
      const onConnect = (e: Event) => {
        const d = (e as Event & { device: HidDeviceLike }).device
        if (!current && isSpaceMouse(d)) void attach?.(d)
      }
      const onDisconnect = (e: Event) => {
        const d = (e as Event & { device: HidDeviceLike }).device
        if (d !== current) return
        d.removeEventListener('inputreport', onInput)
        current = null
        onStatus({ state: 'none' })
        // another remembered device may still be plugged in
        void hid.getDevices().then((all) => all.find((x) => x !== d && isSpaceMouse(x))).then((next) => next && attach?.(next))
      }
      hid.addEventListener('connect', onConnect)
      hid.addEventListener('disconnect', onDisconnect)
      onStatus({ state: 'none' })
      void hid
        .getDevices()
        .then((all) => {
          const d = all.find(isSpaceMouse)
          if (d) return attach?.(d)
        })
        .catch(() => {})
      return () => {
        stopped = true
        attach = null
        hid.removeEventListener('connect', onConnect)
        hid.removeEventListener('disconnect', onDisconnect)
        if (current) {
          current.removeEventListener('inputreport', onInput)
          void current.close().catch(() => {})
          current = null
        }
      }
    },
    async connect() {
      const picked = await hid.requestDevice({ filters: HID_FILTERS })
      const d = picked.find(isSpaceMouse)
      if (d) await attach?.(d)
    },
  }
}

// ---------- the source in use ----------

let webHid: SpaceMouseSource | null | undefined

/** The desktop shell's reader when one is registered, else the browser's WebHID. */
export function spaceMouseSource(): SpaceMouseSource | null {
  const reg = registeredSpaceMouseSource()
  if (reg !== undefined) return reg
  if (webHid === undefined) webHid = webHidSource()
  return webHid
}

/** Feeds one raw report (id first) through: motion to the 3D view, button presses to the camera. Exported for tests. */
export function handleSpaceReport(bytes: Uint8Array, prev: SpaceReportState): SpaceReportState {
  const { state, kind } = parseSpaceReportBytes(bytes, prev)
  if (kind === 'motion') emitSpaceFrame(state.frame)
  else if (kind === 'buttons') {
    for (const a of spaceButtonPresses(prev.buttons, state.buttons)) setCamera(a === 'fit' ? 'fit' : 'iso')
  }
  return state
}

let stop: (() => void) | null = null
let started = false
let unwatch: (() => void) | null = null

function run(enabled: boolean): void {
  const src = spaceMouseSource()
  if (!src) return
  if (enabled && !stop) {
    let st = EMPTY_REPORT_STATE
    stop = src.start(
      (bytes) => {
        st = handleSpaceReport(bytes, st)
      },
      (s) => {
        // a device that went away takes its held buttons and axes with it, so the first press after it is back counts
        if (s.state !== 'connected') st = EMPTY_REPORT_STATE
        setSpaceMouseStatus(s)
      },
    )
  } else if (!enabled && stop) {
    stop()
    stop = null
    setSpaceMouseStatus(SPACE_MOUSE_OFF)
  }
}

/**
 * Starts following the setting: reading while it is on, nothing while off. The app calls it once at start, so a setting
 * saved on comes back on, and turning it on anywhere (Settings, the app link) starts reading. Safe to call again.
 */
export function startSpaceMouse(): void {
  if (started) return
  started = true
  run(appStore.getState().spaceMouse.enabled)
  unwatch = appStore.subscribe((s, p) => {
    if (s.spaceMouse.enabled !== p.spaceMouse.enabled) run(s.spaceMouse.enabled)
  })
}

/** Tests only: stops reading and forgets the source, as a fresh page load would. */
export function resetSpaceMouseForTests(): void {
  stop?.()
  stop = null
  unwatch?.()
  unwatch = null
  started = false
  webHid = undefined
  resetSpaceMouseStateForTests()
}

/**
 * The Connect 3D mouse button: turns the setting on and, in the browser, asks for the device. Must run from the click
 * itself, since the browser shows its device picker only for a user gesture.
 */
export async function connectSpaceMouse(): Promise<void> {
  const src = spaceMouseSource()
  if (!src) return
  // the picker must open inside the click, before anything is awaited
  const asked = src.connect?.()
  const s = appStore.getState().spaceMouse
  if (!s.enabled) set({ spaceMouse: { ...s, enabled: true } })
  startSpaceMouse()
  try {
    await asked
  } catch (e) {
    // closing the picker with nothing picked is not an error; anything else is said plainly
    if ((e as { name?: unknown } | null)?.name === 'NotFoundError') return
    setSpaceMouseStatus({ state: 'error', message: "The browser didn't let the app reach the 3D mouse. Reload the page and press Connect 3D mouse again." })
  }
}
