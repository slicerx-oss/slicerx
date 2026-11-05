// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// 3D mouse (six axis controller) input as data: the HID reports such a device sends, and the camera motion a frame of
// them asks for. The viewport applies the motion each frame (viewport.ts, stepSpaceMouse); the app reads the device
// (WebHID in the browser, the desktop shell's HID reader) and hands the raw reports here. No three.js import, so the
// parser and the mapping are tested without a canvas.
//
// Report layout (the public HID layout of these devices, usage page 0x01 Generic Desktop, usage 0x08 Multi-axis
// Controller). Every value is a signed 16-bit little-endian count, about -350 to 350 at full push:
//   report 1: translation X, Y, Z (6 bytes). Newer devices send rotation in the same report (12 bytes).
//   report 2: rotation RX, RY, RZ (6 bytes).
//   report 3: buttons, one bit each, bit 0 the first (left) button.
// Axes as the device reports them: X to the right, Y toward the person, Z down; RX, RY and RZ turn about those axes.

/** One frame of the six axes, in raw device counts. */
export interface SpaceFrame {
  tx: number
  ty: number
  tz: number
  rx: number
  ry: number
  rz: number
}

export const ZERO_FRAME: Readonly<SpaceFrame> = Object.freeze({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 })

/** Full push in device counts; larger values are clamped. */
export const SPACE_FULL_SCALE = 350

/** Maker vendor ids: the older devices carry Logitech's, the newer ones their own. */
export const SPACE_MOUSE_VENDORS: readonly number[] = [0x046d, 0x256f]
/** HID usage of a six axis controller (Generic Desktop, Multi-axis Controller). */
export const SPACE_MOUSE_USAGE = { usagePage: 0x01, usage: 0x08 } as const

/** The device state a stream of reports builds up. */
export interface SpaceReportState {
  frame: SpaceFrame
  /** Pressed buttons, bit 0 the first. */
  buttons: number
}

export const EMPTY_REPORT_STATE: Readonly<SpaceReportState> = Object.freeze({ frame: ZERO_FRAME, buttons: 0 })

export interface SpaceReportResult {
  state: SpaceReportState
  /** What the report changed: the axes, the buttons, or nothing it understood. */
  kind: 'motion' | 'buttons' | null
}

const i16 = (d: Uint8Array, at: number): number => {
  const v = (d[at] ?? 0) | ((d[at + 1] ?? 0) << 8)
  return v >= 0x8000 ? v - 0x10000 : v
}

/**
 * Reads one input report. `data` is the report without its id byte (as WebHID hands it); `parseSpaceReportBytes` takes
 * the id as the first byte (as a raw HID read returns it). Reports the layout does not cover (battery level, for
 * example) leave the state as it was.
 */
export function parseSpaceReport(reportId: number, data: Uint8Array, prev: SpaceReportState = EMPTY_REPORT_STATE): SpaceReportResult {
  if (reportId === 1 && data.length >= 6) {
    const f: SpaceFrame = { ...prev.frame, tx: i16(data, 0), ty: i16(data, 2), tz: i16(data, 4) }
    if (data.length >= 12) {
      f.rx = i16(data, 6)
      f.ry = i16(data, 8)
      f.rz = i16(data, 10)
    }
    return { state: { frame: f, buttons: prev.buttons }, kind: 'motion' }
  }
  if (reportId === 2 && data.length >= 6) {
    return { state: { frame: { ...prev.frame, rx: i16(data, 0), ry: i16(data, 2), rz: i16(data, 4) }, buttons: prev.buttons }, kind: 'motion' }
  }
  if (reportId === 3 && data.length >= 1) {
    let mask = 0
    for (let i = 0; i < Math.min(4, data.length); i++) mask |= (data[i] ?? 0) << (8 * i)
    return { state: { frame: prev.frame, buttons: mask >>> 0 }, kind: 'buttons' }
  }
  return { state: prev, kind: null }
}

/** As parseSpaceReport, with the report id as the first byte. */
export function parseSpaceReportBytes(bytes: Uint8Array, prev: SpaceReportState = EMPTY_REPORT_STATE): SpaceReportResult {
  if (bytes.length < 1) return { state: prev, kind: null }
  return parseSpaceReport(bytes[0] ?? 0, bytes.subarray(1), prev)
}

/** What a device button does: the first resets the view, the second fits it. Others do nothing. */
export type SpaceButtonAction = 'reset' | 'fit'

/** The actions of the buttons that went down between two button masks. A release does nothing. */
export function spaceButtonPresses(prev: number, next: number): SpaceButtonAction[] {
  const down = next & ~prev
  const out: SpaceButtonAction[] = []
  if (down & 1) out.push('reset')
  if (down & 2) out.push('fit')
  return out
}

/** The five camera moves a person can tune. Roll (RY) is not used: the camera keeps the plate's up direction. */
export type SpaceAxis = 'panX' | 'panY' | 'zoom' | 'tilt' | 'spin'
export const SPACE_AXES: readonly SpaceAxis[] = ['panX', 'panY', 'zoom', 'tilt', 'spin']

export interface SpaceMouseSettings {
  enabled: boolean
  /** Speed multiplier, SPACE_SENSITIVITY.min to max. */
  sensitivity: number
  /** Axes whose direction is flipped. */
  invert: Readonly<Record<SpaceAxis, boolean>>
  /** Only the strongest axis moves the view at a time. */
  dominantAxis: boolean
}

export const SPACE_SENSITIVITY = { min: 0.25, max: 4, step: 0.05 } as const

export const DEFAULT_SPACE_MOUSE: Readonly<SpaceMouseSettings> = Object.freeze({
  enabled: false,
  sensitivity: 1,
  invert: Object.freeze({ panX: false, panY: false, zoom: false, tilt: false, spin: false }),
  dominantAxis: false,
})

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Settings read back from storage or an outside caller: each field checked on its own, a bad one falls back to its default. */
export function normalizeSpaceMouse(v: unknown): SpaceMouseSettings {
  const r = isRec(v) ? v : {}
  const d = DEFAULT_SPACE_MOUSE
  const inv = isRec(r['invert']) ? r['invert'] : {}
  const s = r['sensitivity']
  const sensitivity = typeof s === 'number' && Number.isFinite(s) ? Math.min(SPACE_SENSITIVITY.max, Math.max(SPACE_SENSITIVITY.min, s)) : d.sensitivity
  const invert = Object.fromEntries(SPACE_AXES.map((a) => [a, typeof inv[a] === 'boolean' ? inv[a] : d.invert[a]])) as Record<SpaceAxis, boolean>
  return {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : d.enabled,
    sensitivity,
    invert,
    dominantAxis: typeof r['dominantAxis'] === 'boolean' ? r['dominantAxis'] : d.dominantAxis,
  }
}

/** Share of full push ignored around rest, so a cap at rest or a resting hand does not drift the view. */
export const SPACE_DEAD_ZONE = 0.06

/** Speeds at full push and sensitivity 1. */
export const SPACE_RATES = {
  /** View heights per second. */
  pan: 1,
  /** Natural log of the zoom factor per second (about 3.3 times closer per second). */
  zoom: 1.2,
  /** Radians per second. */
  orbit: 2.2,
} as const

/** The response past the dead zone rises as a power of the push, for fine control near rest. */
const CURVE = 1.6

/** One axis in -1..1: clamped to full scale, the dead zone removed and the rest rescaled, then curved. */
export function shapeAxis(counts: number, deadZone = SPACE_DEAD_ZONE): number {
  if (!Number.isFinite(counts)) return 0
  const v = Math.max(-1, Math.min(1, counts / SPACE_FULL_SCALE))
  const a = Math.abs(v)
  if (a <= deadZone) return 0
  const k = (a - deadZone) / (1 - deadZone)
  return Math.sign(v) * Math.pow(k, CURVE)
}

/**
 * The five camera axes of a frame, each in -1..1 with the dead zone, inversion and dominant axis applied. Positive
 * means: panX the scene moves right, panY the scene moves up, zoom closer, tilt the view looks down from higher up,
 * spin the scene turns counterclockwise seen from above. The cap moves the scene the way it is pushed: right moves it
 * right, a lift raises it, a pull toward the person brings it closer.
 */
export function spaceAxes(frame: SpaceFrame, settings: Pick<SpaceMouseSettings, 'invert' | 'dominantAxis'>): Record<SpaceAxis, number> {
  const raw: Record<SpaceAxis, number> = {
    panX: shapeAxis(frame.tx),
    panY: -shapeAxis(frame.tz),
    zoom: shapeAxis(frame.ty),
    tilt: shapeAxis(frame.rx),
    spin: shapeAxis(frame.rz),
  }
  for (const a of SPACE_AXES) {
    if (settings.invert[a]) raw[a] = -raw[a]
    if (raw[a] === 0) raw[a] = 0 // no negative zero
  }
  if (settings.dominantAxis) {
    let best: SpaceAxis | null = null
    for (const a of SPACE_AXES) if (raw[a] !== 0 && (best === null || Math.abs(raw[a]) > Math.abs(raw[best]))) best = a
    for (const a of SPACE_AXES) if (a !== best) raw[a] = 0
  }
  return raw
}

/** Camera motion for one frame. */
export interface SpaceMotion {
  /** Scene moves right and up, in view heights. */
  panX: number
  panY: number
  /** Distance divided by this: above 1 closer, below 1 farther. */
  zoom: number
  /** Orbit around the center in radians: azimuth (spin) and elevation (tilt). */
  orbitX: number
  orbitY: number
}

/** Below this the smoothed axes count as at rest. */
const REST = 1e-3

/**
 * Smooths axes toward the device's latest values with time constant `tauMs` (0: no smoothing, the view stops the
 * moment the cap is let go). Returns the new values.
 */
export function smoothAxes(prev: Readonly<Record<SpaceAxis, number>>, next: Readonly<Record<SpaceAxis, number>>, dtMs: number, tauMs: number): Record<SpaceAxis, number> {
  const k = tauMs <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / tauMs)
  const out = {} as Record<SpaceAxis, number>
  for (const a of SPACE_AXES) {
    const v = prev[a] + (next[a] - prev[a]) * k
    out[a] = Math.abs(v) < REST && next[a] === 0 ? 0 : v
  }
  return out
}

export const SPACE_REST: Readonly<Record<SpaceAxis, number>> = Object.freeze({ panX: 0, panY: 0, zoom: 0, tilt: 0, spin: 0 })

export function axesAtRest(a: Readonly<Record<SpaceAxis, number>>): boolean {
  return SPACE_AXES.every((k) => a[k] === 0)
}

/** The motion `dtMs` of these axes asks for at this sensitivity, or null when nothing moves. */
export function spaceMotion(axes: Readonly<Record<SpaceAxis, number>>, sensitivity: number, dtMs: number): SpaceMotion | null {
  if (axesAtRest(axes) || !(dtMs > 0)) return null
  const s = Math.min(SPACE_SENSITIVITY.max, Math.max(SPACE_SENSITIVITY.min, sensitivity))
  const t = (dtMs / 1000) * s
  return {
    panX: axes.panX * SPACE_RATES.pan * t,
    panY: axes.panY * SPACE_RATES.pan * t,
    zoom: Math.exp(axes.zoom * SPACE_RATES.zoom * t),
    orbitX: axes.spin * SPACE_RATES.orbit * t,
    orbitY: axes.tilt * SPACE_RATES.orbit * t,
  }
}

/** The longest step one frame may take, so a frame after a stall does not jump the view. */
export const SPACE_MAX_STEP_MS = 50
/** Smoothing time constant with full motion; reduced motion uses none. */
export const SPACE_SMOOTH_MS = 50
/** Axes the device has not repeated for this long count as let go (a lost release report must not spin the view forever). */
export const SPACE_STALE_MS = 1000

/** One frame's mapping in one call: the frame and settings in, the motion out. */
export function mapSpaceFrame(frame: SpaceFrame, settings: SpaceMouseSettings, dtMs: number): SpaceMotion | null {
  if (!settings.enabled) return null
  return spaceMotion(spaceAxes(frame, settings), settings.sensitivity, Math.min(SPACE_MAX_STEP_MS, dtMs))
}
