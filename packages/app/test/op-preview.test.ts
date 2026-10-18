// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The operation preview's state: a failed edit keeps the last good preview with its error, a good one replaces it,
// and clearing drops it. The link's report says the same.
import { afterEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { set } from '../src/state/store'
import { NO_PREVIEW, previewMessage, sizeWords, previewReport, publishPreview, reportOf, stepPreview, type OpPreview, type OpPreviewEvent } from '../src/cad/op-preview'

const run = <T>(events: OpPreviewEvent<T>[]): OpPreview<T> => events.reduce<OpPreview<T>>((s, e) => stepPreview(s, e), NO_PREVIEW as OpPreview<T>)

describe('operation preview state', () => {
  it('shows each good preview and keeps the last one through an error', () => {
    const s = run<number>([{ type: 'request' }, { type: 'ok', value: 5 }, { type: 'request' }, { type: 'ok', value: 8 }, { type: 'fail', message: 'Type a number, such as 5 or -3.' }])
    expect(s).toEqual({ status: 'error', shown: 8, error: 'Type a number, such as 5 or -3.', stale: true })
    expect(previewMessage(s)).toBe('Type a number, such as 5 or -3. Showing the last good preview.')
    // A good edit after the error replaces it and the error goes.
    expect(stepPreview(s, { type: 'ok', value: -3 })).toEqual({ status: 'ok', shown: -3, error: null, stale: false })
  })

  it('keeps the shown preview while a new one is worked on', () => {
    const s = run<string>([{ type: 'ok', value: 'a' }, { type: 'request' }])
    expect(s).toEqual({ status: 'pending', shown: 'a', error: null, stale: true })
    expect(previewMessage(s)).toBeNull()
  })

  it('an error with nothing shown yet says only the error', () => {
    const s = run<number>([{ type: 'request' }, { type: 'fail', message: 'The radius is too big for this edge.' }])
    expect(s).toEqual({ status: 'error', shown: null, error: 'The radius is too big for this edge.', stale: false })
    expect(previewMessage(s)).toBe('The radius is too big for this edge.')
  })

  it('clearing drops the kept preview and the error', () => {
    expect(run<number>([{ type: 'ok', value: 2 }, { type: 'fail', message: 'x' }, { type: 'clear' }])).toBe(NO_PREVIEW)
  })

  it('returns the same state for an event that changes nothing, so React skips the render', () => {
    const ok = run<number>([{ type: 'ok', value: 2 }])
    expect(stepPreview(ok, { type: 'ok', value: 2 })).toBe(ok)
    const bad = stepPreview(ok, { type: 'fail', message: 'x' })
    expect(stepPreview(bad, { type: 'fail', message: 'x' })).toBe(bad)
    const wait = stepPreview(ok, { type: 'request' })
    expect(stepPreview(wait, { type: 'request' })).toBe(wait)
    expect(stepPreview(NO_PREVIEW, { type: 'clear' })).toBe(NO_PREVIEW)
  })

  it("puts the engine's size errors in the field's words", () => {
    expect(sizeWords('RadiusMm: 50 mm does not fit on this face; at most 20.000 mm')).toBe('Radius 50 mm does not fit on this face; at most 20 mm.')
    expect(sizeWords('radiusMm: 30 mm does not fit on this face; at most 20.000 mm')).toBe('Radius 30 mm does not fit on this face; at most 20 mm.')
    expect(sizeWords('distanceMm: 6.5 mm does not fit on this face; at most 2.125 mm')).toBe('Distance 6.5 mm does not fit on this face; at most 2.13 mm.')
    expect(sizeWords('The edge is gone.')).toBe('The edge is gone.')
  })

  it("puts every tool's engine refusals in plain words, without its keys", () => {
    // Push and pull at 20000 mm: the engine's range check, after errorText capitalized it
    expect(sizeWords('DistanceMm: must not be zero (at most 10000 mm)', 20000)).toBe('The distance is too large. The most is 10000 mm.')
    expect(sizeWords('distanceMm: must not be zero (at most 10000 mm)', -20000)).toBe('The distance is too large. The most is 10000 mm.')
    expect(sizeWords('distanceMm: must not be zero (at most 10000 mm)', 0)).toBe("The distance can't be 0 mm.")
    expect(sizeWords('distanceMm: must not be zero (at most 10000 mm)')).toBe('The distance must be between -10000 and 10000 mm, and not 0.')
    // Shell
    expect(sizeWords('WallMm: must be above 0 (at most 1000 mm)', 0)).toBe('The wall must be more than 0 mm.')
    expect(sizeWords('wallMm: must be above 0 (at most 1000 mm)', 1500)).toBe('The wall is too large. The most is 1000 mm.')
    expect(sizeWords('wallMm: the wall is too thick for this body; try a thinner one')).toBe('The wall is too thick for this body; try a thinner one.')
    // Subtract
    expect(sizeWords('diameterMm: must be above 0')).toBe('The diameter must be more than 0 mm.')
    expect(sizeWords('Invalid type: null, expected f64')).toBe('Type a number in every box.')
    // Fillet stays as it was
    expect(sizeWords('radiusMm: must be above 0 (at most 1000 mm)', 0)).toBe('The radius must be more than 0 mm.')
    // a key the list does not know is dropped, never shown
    expect(sizeWords('offsetMm: the shape runs off the face')).toBe('The shape runs off the face.')
    for (const m of ['DistanceMm: must not be zero (at most 10000 mm)', 'WallMm: must be above 0 (at most 1000 mm)', 'diameterMm: must be above 0', 'Invalid type: null, expected f64']) expect(sizeWords(m, 0)).not.toMatch(/\w+Mm\b|null|f64/)
  })

  it('reports to the link what the view shows', () => {
    const kept = run<number>([{ type: 'ok', value: -4 }, { type: 'fail', message: 'Type a number, such as 5 or -3.' }])
    const r = reportOf('push', kept, { adds: false, removes: true })
    expect(r).toEqual({ tool: 'push', status: 'error', message: 'Type a number, such as 5 or -3. Showing the last good preview.', showingLastGood: true, adds: false, removes: true })
    // nothing shown: nothing added or removed, whatever the tool says
    expect(reportOf('fillet', NO_PREVIEW, { adds: true, removes: true })).toMatchObject({ status: 'none', adds: false, removes: false, showingLastGood: false })
    publishPreview(r)
    expect(previewReport()).toBe(r)
    // an equal report keeps the one published
    publishPreview({ ...r })
    expect(previewReport()).toBe(r)
    publishPreview(null)
    expect(previewReport()).toBeNull()
  })
})

describe('app link: the open tool\'s operation preview', () => {
  afterEach(() => {
    publishPreview(null)
    set({ objectTool: null })
  })

  it('is a read method, pinned in the list', () => {
    expect(APP_LINK_METHODS['model.op_preview']).toBe('read')
  })

  it('reads the preview of the open tool, and nothing while none is open', async () => {
    expect(await runCall('model.op_preview', {})).toEqual({ open: false, tool: null, status: 'none', message: null, showingLastGood: false, adds: false, removes: false })
    const kept = run<number>([{ type: 'ok', value: 3 }, { type: 'fail', message: 'Type a number, such as 5 or -3.' }])
    set({ objectTool: 'push' })
    publishPreview(reportOf('push', kept, { adds: true, removes: false }))
    expect(await runCall('model.op_preview', {})).toEqual({ open: true, tool: 'push', status: 'error', message: 'Type a number, such as 5 or -3. Showing the last good preview.', showingLastGood: true, adds: true, removes: false })
    // the tool closed under a stale report: nothing is open
    set({ objectTool: null })
    expect(await runCall('model.op_preview', {})).toMatchObject({ open: false })
  })
})
