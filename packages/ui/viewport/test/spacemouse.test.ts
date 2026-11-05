// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPACE_MOUSE,
  EMPTY_REPORT_STATE,
  SPACE_DEAD_ZONE,
  SPACE_FULL_SCALE,
  SPACE_MAX_STEP_MS,
  SPACE_RATES,
  SPACE_REST,
  ZERO_FRAME,
  mapSpaceFrame,
  normalizeSpaceMouse,
  parseSpaceReport,
  parseSpaceReportBytes,
  shapeAxis,
  smoothAxes,
  spaceAxes,
  spaceButtonPresses,
  spaceMotion,
  type SpaceFrame,
  type SpaceMouseSettings,
  type SpaceReportState,
} from '../src/spacemouse'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/spacemouse-reports.json', import.meta.url), 'utf8')) as { separate: { hex: string }[]; combined: { hex: string }[] }
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
const on: SpaceMouseSettings = { ...DEFAULT_SPACE_MOUSE, enabled: true }
const frame = (f: Partial<SpaceFrame>): SpaceFrame => ({ ...ZERO_FRAME, ...f })

describe('3D mouse reports', () => {
  it('reads the separate translation, rotation and button reports of the fixture in order', () => {
    let s: SpaceReportState = EMPTY_REPORT_STATE
    const kinds: (string | null)[] = []
    const seen: SpaceReportState[] = []
    for (const r of fixture.separate) {
      const out = parseSpaceReportBytes(bytes(r.hex), s)
      kinds.push(out.kind)
      s = out.state
      seen.push(s)
    }
    expect(kinds).toEqual(['motion', 'motion', 'buttons', 'buttons', 'buttons', null, 'motion', 'motion'])
    expect(seen[0]!.frame).toEqual(frame({ tx: 175 }))
    // rotation lands beside the translation already read
    expect(seen[1]!.frame).toEqual(frame({ tx: 175, rz: -350 }))
    expect(seen.slice(2, 5).map((x) => x.buttons)).toEqual([1, 0, 2])
    // the battery report changes nothing
    expect(seen[5]).toBe(seen[4])
    expect(s.frame).toEqual(ZERO_FRAME)
    expect(s.buttons).toBe(2)
  })

  it('reads all six axes from the combined report newer devices send', () => {
    const out = parseSpaceReportBytes(bytes(fixture.combined[0]!.hex))
    expect(out.kind).toBe('motion')
    expect(out.state.frame).toEqual({ tx: -350, ty: 350, tz: -20, rx: 100, ry: -1, rz: 0 })
  })

  it('takes WebHID reports without the id byte the same way', () => {
    const raw = bytes(fixture.combined[0]!.hex)
    expect(parseSpaceReport(raw[0]!, raw.subarray(1)).state).toEqual(parseSpaceReportBytes(raw).state)
  })

  it('ignores short reports and an empty read', () => {
    expect(parseSpaceReportBytes(new Uint8Array(0)).kind).toBeNull()
    expect(parseSpaceReportBytes(bytes('01af00')).kind).toBeNull()
    expect(parseSpaceReportBytes(bytes('02')).kind).toBeNull()
  })

  it('acts on button presses, not releases or held buttons', () => {
    expect(spaceButtonPresses(0, 1)).toEqual(['reset'])
    expect(spaceButtonPresses(0, 2)).toEqual(['fit'])
    expect(spaceButtonPresses(1, 0)).toEqual([])
    expect(spaceButtonPresses(1, 1)).toEqual([])
    expect(spaceButtonPresses(1, 3)).toEqual(['fit'])
    expect(spaceButtonPresses(0, 4)).toEqual([])
  })
})

describe('3D mouse mapping', () => {
  it('ignores pushes inside the dead zone and reaches full speed at full push', () => {
    const edge = SPACE_DEAD_ZONE * SPACE_FULL_SCALE
    expect(shapeAxis(0)).toBe(0)
    expect(shapeAxis(edge - 1)).toBe(0)
    expect(shapeAxis(-(edge - 1))).toBe(0)
    expect(shapeAxis(edge + 5)).toBeGreaterThan(0)
    expect(shapeAxis(SPACE_FULL_SCALE)).toBe(1)
    expect(shapeAxis(-SPACE_FULL_SCALE)).toBe(-1)
    // clamped past full scale, and a bad value is no motion
    expect(shapeAxis(900)).toBe(1)
    expect(shapeAxis(Number.NaN)).toBe(0)
  })

  it('rises slowly near rest for fine control', () => {
    const half = shapeAxis(SPACE_FULL_SCALE / 2)
    expect(half).toBeGreaterThan(0)
    expect(half).toBeLessThan(0.5)
  })

  it('maps each device axis to one camera move', () => {
    const f = SPACE_FULL_SCALE
    expect(spaceAxes(frame({ tx: f }), on)).toEqual({ panX: 1, panY: 0, zoom: 0, tilt: 0, spin: 0 })
    // a lift (negative Z, which points down) raises the scene
    expect(spaceAxes(frame({ tz: -f }), on)).toEqual({ panX: 0, panY: 1, zoom: 0, tilt: 0, spin: 0 })
    // a pull toward the person brings it closer
    expect(spaceAxes(frame({ ty: f }), on)).toEqual({ panX: 0, panY: 0, zoom: 1, tilt: 0, spin: 0 })
    expect(spaceAxes(frame({ rx: f }), on)).toEqual({ panX: 0, panY: 0, zoom: 0, tilt: 1, spin: 0 })
    expect(spaceAxes(frame({ rz: -f }), on)).toEqual({ panX: 0, panY: 0, zoom: 0, tilt: 0, spin: -1 })
    // roll is not used: the camera keeps the plate's up direction
    expect(spaceAxes(frame({ ry: f }), on)).toEqual(SPACE_REST)
  })

  it('inverts each axis on its own', () => {
    const f = frame({ tx: 350, tz: -350, ty: 350, rx: 350, rz: 350 })
    expect(spaceAxes(f, { ...on, invert: { ...on.invert, zoom: true } })).toEqual({ panX: 1, panY: 1, zoom: -1, tilt: 1, spin: 1 })
    expect(spaceAxes(f, { ...on, invert: { panX: true, panY: true, zoom: false, tilt: true, spin: false } })).toEqual({ panX: -1, panY: -1, zoom: 1, tilt: -1, spin: 1 })
  })

  it('keeps only the strongest axis in dominant axis mode', () => {
    const f = frame({ tx: 200, rz: 300, ty: -100 })
    const all = spaceAxes(f, on)
    expect(all.panX).not.toBe(0)
    expect(all.zoom).not.toBe(0)
    const one = spaceAxes(f, { ...on, dominantAxis: true })
    expect(one).toEqual({ ...SPACE_REST, spin: shapeAxis(300) })
    expect(spaceAxes(ZERO_FRAME, { ...on, dominantAxis: true })).toEqual(SPACE_REST)
  })

  it('scales motion by time and sensitivity', () => {
    const axes = { ...SPACE_REST, panX: 1, spin: 1, zoom: 1 }
    const m = spaceMotion(axes, 1, 1000)!
    expect(m.panX).toBeCloseTo(SPACE_RATES.pan)
    expect(m.orbitX).toBeCloseTo(SPACE_RATES.orbit)
    expect(m.zoom).toBeCloseTo(Math.exp(SPACE_RATES.zoom))
    const fast = spaceMotion(axes, 2, 500)!
    expect(fast.panX).toBeCloseTo(m.panX)
    const half = spaceMotion(axes, 0.5, 1000)!
    expect(half.orbitX).toBeCloseTo(m.orbitX / 2)
    // a pull away zooms out
    expect(spaceMotion({ ...SPACE_REST, zoom: -1 }, 1, 100)!.zoom).toBeLessThan(1)
  })

  it('asks for nothing at rest, when off, or with no time passed', () => {
    expect(spaceMotion(SPACE_REST, 1, 16)).toBeNull()
    expect(mapSpaceFrame(frame({ tx: 350 }), DEFAULT_SPACE_MOUSE, 16)).toBeNull()
    expect(mapSpaceFrame(frame({ tx: 350 }), on, 0)).toBeNull()
    expect(mapSpaceFrame(frame({ tx: 10 }), on, 16)).toBeNull()
  })

  it('caps one frame step so a stalled frame does not jump the view', () => {
    const long = mapSpaceFrame(frame({ tx: 350 }), on, 2000)!
    const cap = mapSpaceFrame(frame({ tx: 350 }), on, SPACE_MAX_STEP_MS)!
    expect(long.panX).toBeCloseTo(cap.panX)
  })

  it('smooths toward the device, and stops at once with no smoothing', () => {
    const push = { ...SPACE_REST, panX: 1 }
    const a = smoothAxes(SPACE_REST, push, 16, 50)
    expect(a.panX).toBeGreaterThan(0)
    expect(a.panX).toBeLessThan(1)
    expect(smoothAxes(SPACE_REST, push, 16, 0)).toEqual(push)
    expect(smoothAxes(push, SPACE_REST, 16, 0)).toEqual(SPACE_REST)
    // a smoothed tail settles to exact rest
    let s = push
    for (let i = 0; i < 200; i++) s = smoothAxes(s, SPACE_REST, 16, 50)
    expect(s).toEqual(SPACE_REST)
  })
})

describe('3D mouse settings', () => {
  it('starts off, at normal speed, nothing inverted', () => {
    expect(normalizeSpaceMouse(undefined)).toEqual(DEFAULT_SPACE_MOUSE)
  })

  it('keeps good fields and drops bad ones one by one', () => {
    const s = normalizeSpaceMouse({ enabled: true, sensitivity: 9, invert: { zoom: true, tilt: 'yes' }, dominantAxis: 1 })
    expect(s).toEqual({ enabled: true, sensitivity: 4, invert: { panX: false, panY: false, zoom: true, tilt: false, spin: false }, dominantAxis: false })
    expect(normalizeSpaceMouse({ sensitivity: 0 }).sensitivity).toBe(0.25)
    expect(normalizeSpaceMouse({ sensitivity: Number.NaN }).sensitivity).toBe(1)
    expect(normalizeSpaceMouse([1, 2]).enabled).toBe(false)
  })
})
