// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Push and pull in the view: which operation a distance makes, how a drag on the arrow turns into a distance, where the
// arrow and its Distance box sit on screen, and the app link reading and typing the pending distance.
import { afterEach, describe, expect, it } from 'vitest'
import { arrowGeom, boxSpot, distanceText, dragDistance, niceStep, OP_LABEL, publishPush, pushOperation, type PushSnapshot } from '../src/cad/push-session'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { set } from '../src/state/store'

type V3 = [number, number, number]

describe('push operation', () => {
  it('a positive distance pulls out, a negative one cuts, and one past the far side cuts through', () => {
    expect(pushOperation(5, 10)).toBe('pull')
    expect(pushOperation(-3, 10)).toBe('cut')
    expect(pushOperation(-10, 10)).toBe('through')
    expect(pushOperation(-12, 10)).toBe('through')
    // no far side found: a cut never claims a hole
    expect(pushOperation(-50, null)).toBe('cut')
    expect(pushOperation(0, 10)).toBeNull()
    expect(pushOperation(null, 10)).toBeNull()
    expect(pushOperation(Number.NaN, 10)).toBeNull()
    expect([OP_LABEL.pull, OP_LABEL.cut, OP_LABEL.through]).toEqual(['Pull out', 'Cut', 'Cut through'])
  })
})

describe('drag on the arrow', () => {
  it('rounds to a step that suits the zoom', () => {
    expect(niceStep(0.3)).toBe(0.2)
    expect(niceStep(0.8)).toBe(1)
    expect(niceStep(3)).toBe(2)
    expect(niceStep(4)).toBe(5)
    expect(niceStep(0.001)).toBe(0.01)
    expect(niceStep(0)).toBe(0.01)
  })

  it('moves the distance by the pointer along the arrow, in steps, whole mm with Shift and free with Alt', () => {
    // 10 px per mm: 8 px is 0.8 mm, so the step is 1 mm
    expect(dragDistance(0, 52, 10)).toBe(5)
    expect(dragDistance(5, -80, 10)).toBe(-3)
    // 2 px per mm: 4 mm steps round to 5
    expect(dragDistance(0, 23, 2)).toBe(10)
    // Shift: whole millimeters at any zoom
    expect(dragDistance(0, 23, 2, { shift: true })).toBe(12)
    // Alt: free values, two decimals
    expect(dragDistance(0, 23, 2, { alt: true })).toBe(11.5)
    expect(dragDistance(1.25, 1, 100, { alt: true })).toBe(1.26)
    // no -0
    expect(Object.is(dragDistance(0, -1, 10), 0)).toBe(true)
  })

  it('shows a distance without trailing zeros', () => {
    expect(distanceText(5)).toBe('5')
    expect(distanceText(-2.5)).toBe('-2.5')
    expect(distanceText(0.1 + 0.2)).toBe('0.3')
    expect(distanceText(-0)).toBe('0')
  })
})

describe('arrow on screen', () => {
  // A plain projection: x right, z up on screen (y ignored), 10 px per mm, origin at (500, 400).
  const flat = (p: V3): [number, number] => [500 + p[0] * 10, 400 - p[2] * 10]

  it('stands on the face along its normal, as long as the distance and at least 40 px', () => {
    const g = arrowGeom(flat, [0, 0, 0], [0, 0, 1], 10, { x: 0, y: 0 })!
    expect(g.base).toEqual({ x: 500, y: 400 })
    expect(g.tip).toEqual({ x: 500, y: 300 })
    expect(g.out).toEqual({ x: 0, y: -1 })
    expect(g.pxPerMm).toBeCloseTo(10)
    // a short push still has 40 px to grab
    expect(arrowGeom(flat, [0, 0, 0], [0, 0, 1], 1, { x: 0, y: 0 })!.tip).toEqual({ x: 500, y: 360 })
    // a cut points into the body
    expect(arrowGeom(flat, [0, 0, 0], [0, 0, 1], -6, { x: 0, y: 0 })!.tip).toEqual({ x: 500, y: 460 })
    // relative to the layer
    expect(arrowGeom(flat, [0, 0, 0], [1, 0, 0], 8, { x: 100, y: 50 })!.tip).toEqual({ x: 480, y: 350 })
  })

  it('stands up on screen when the face looks straight at the camera', () => {
    // the normal is +y, which this projection drops
    const g = arrowGeom(flat, [0, 0, 0], [0, 1, 0], 20, { x: 0, y: 0 })!
    expect(g.out).toEqual({ x: 0, y: -1 })
    expect(g.pxPerMm).toBeCloseTo(10)
    expect(g.tip).toEqual({ x: 500, y: 200 })
  })

  it('has no arrow before the camera has a frame', () => {
    expect(arrowGeom(() => null, [0, 0, 0], [0, 0, 1], 5, { x: 0, y: 0 })).toBeNull()
  })

  it('puts the box beside the tip and keeps it inside the view', () => {
    const box = { w: 140, h: 60 }
    const view = { w: 800, h: 600 }
    expect(boxSpot({ x: 300, y: 200 }, box, view)).toEqual({ x: 316, y: 170 })
    // right edge
    expect(boxSpot({ x: 760, y: 200 }, box, view)).toEqual({ x: 652, y: 170 })
    // top and bottom
    expect(boxSpot({ x: 300, y: 4 }, box, view)).toEqual({ x: 316, y: 8 })
    expect(boxSpot({ x: 300, y: 598 }, box, view)).toEqual({ x: 316, y: 532 })
  })
})

describe('app link: the open Push and pull', () => {
  const face = { objectId: 'box', partIndex: 0, at: [1, 2, 10] as V3, normal: [0, 0, 1] as V3, thicknessMm: 10 }
  let typed: string[] = []
  const open = (s: Partial<PushSnapshot> = {}) => {
    const snap: PushSnapshot = { face, text: '', distanceMm: null, busy: false, note: null, editStep: null, ...s }
    set({ objectTool: 'push' })
    publishPush(snap, {
      setText: (t) => {
        typed.push(t)
        const d = Number(t)
        open({ ...snap, text: t, distanceMm: Number.isFinite(d) && t.trim() ? d : null })
      },
      apply: async () => false,
    })
  }
  afterEach(() => {
    publishPush(null, null)
    set({ objectTool: null })
    typed = []
  })

  it('reads and types only into the open tool', () => {
    expect(APP_LINK_METHODS['model.push']).toBe('read')
    expect(APP_LINK_METHODS['model.push_set']).toBe('read')
  })

  it('reads the face, the pending distance and the operation it makes', async () => {
    expect(await runCall('model.push', {})).toMatchObject({ open: false, face: null, distanceMm: null, operation: null })
    open({ text: '-4', distanceMm: -4 })
    expect(await runCall('model.push', {})).toEqual({
      open: true,
      face: { object: 'box', part: 0, at: [1, 2, 10], normal: [0, 0, 1], thicknessMm: 10 },
      text: '-4',
      distanceMm: -4,
      operation: 'cut',
      operationLabel: 'Cut',
      busy: false,
    })
  })

  it('types a distance for the person and reads it back; the project does not change', async () => {
    open()
    expect(await runCall('model.push_set', { distanceMm: 7.5 })).toMatchObject({ open: true, text: '7.5', distanceMm: 7.5, operation: 'pull', operationLabel: 'Pull out' })
    expect(await runCall('model.push_set', { distanceMm: -12 })).toMatchObject({ distanceMm: -12, operation: 'through', operationLabel: 'Cut through' })
    expect(typed).toEqual(['7.5', '-12'])
  })

  it('refuses a bad distance, extra arguments, a busy tool and a shut one, typing nothing', async () => {
    const code = async (args: Record<string, unknown>) => {
      const e = await runCall('model.push_set', args).catch((x: unknown) => x)
      expect(e, JSON.stringify(args)).toBeInstanceOf(LinkError)
      return (e as LinkError).code
    }
    expect(await code({ distanceMm: 5 })).toBe('not_found')
    open()
    expect(await code({})).toBe('invalid_input')
    expect(await code({ distanceMm: '5' })).toBe('invalid_input')
    expect(await code({ distanceMm: 5, apply: true })).toBe('invalid_input')
    expect(await code({ distanceMm: 1e9 })).toBe('invalid_input')
    open({ busy: true })
    expect(await code({ distanceMm: 5 })).toBe('busy')
    expect(typed).toEqual([])
  })
})
