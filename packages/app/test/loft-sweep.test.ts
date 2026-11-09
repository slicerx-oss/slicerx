// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Loft and Sweep in Model: which sketch can be a profile or a path and why not, the picked list (order, reorder, take
// off), Closed ring and the primary's reasons, an edge chain as a path, the profile-off-path words, the step the panels
// record (the one builder the design tools use too), and editing a saved step filling the panel from it.
import { loftParams, sweepParams, type FaceFrame, type SketchItem, type Step, type Timeline } from '@slicerx/cad-history'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HostContext } from '../src/host'
import { LoftTool } from '../src/cad/loft-tool'
import { SweepTool } from '../src/cad/sweep-tool'
import { edgePathOf, keptWords, loftReason, matchSketch, movePick, offPathWords, pathOf, profileOf, removePick, ringReason, sweepReason, togglePick } from '../src/cad/loft-sweep'
import { shownSketches, sketchesOff } from '../src/cad/sketch-gates'
import { pickSketch, sketchPicker } from '../src/cad/sketch-pick'
import { get, set, type PlateEntry } from '../src/state/store'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const level = (z: number): FaceFrame => ({ origin: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
const square = (s: number) => ({ points: [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]] as [number, number][] })
const circle = (d: number) => ({ type: 'circle' as const, center: [0, 0] as [number, number], diameterMm: d })
const sketch = (n: number, loops: SketchItem['loops'], frame?: FaceFrame): SketchItem => ({ kind: 'sketch', id: `k${n}`, name: `Sketch ${n}`, ...(frame ? { frame } : {}), loops })
const timeline = (items: SketchItem[]): Timeline => ({ bodies: [], items, marker: items.length }) as unknown as Timeline

describe('profiles and paths from sketches', () => {
  it('takes one closed loop as a profile, a copy on the frame it stands on', () => {
    const k = sketch(1, [square(10)], level(5))
    const r = profileOf(k, level(5), 'loft')
    expect(r).toEqual({ profile: { frame: level(5), loops: [square(10)] } })
    // a copy: changing the sketch later does not change the profile
    if ('profile' in r) expect(r.profile.loops[0]).not.toBe(k.loops[0])
  })

  it('refuses a sketch with several loops, naming it and the count', () => {
    expect(profileOf(sketch(3, [square(10), circle(4)]), level(0), 'loft')).toEqual({ why: 'Sketch 3 has 2 loops; a loft profile is one closed loop.' })
    expect(profileOf(sketch(4, [square(10), circle(4), circle(2)]), level(0), 'sweep')).toEqual({ why: 'Sketch 4 has 3 loops; a sweep profile is one closed loop.' })
  })

  it('refuses an open profile plainly, and leaves construction loops out', () => {
    const open = sketch(2, [{ start: [0, 0], segments: [{ type: 'line', to: [10, 0] }, { type: 'line', to: [10, 10] }] }])
    expect(profileOf(open, level(0), 'loft')).toEqual({ why: 'Sketch 2 is an open line; a loft profile is one closed loop.' })
    const withGuide = sketch(5, [square(10), { ...circle(30), construction: true }])
    expect(profileOf(withGuide, level(0), 'loft')).toEqual({ profile: { frame: level(0), loops: [square(10)] } })
  })

  it('takes one open line as a path and refuses closed or several', () => {
    const line = sketch(6, [{ start: [0, 0], segments: [{ type: 'line', to: [0, 40] }] }])
    expect(pathOf(line, level(0))).toEqual({ path: { frame: level(0), loops: line.loops } })
    expect(pathOf(sketch(7, [circle(10)]), level(0))).toEqual({ why: 'Sketch 7 is closed; a sweep path is one open line with two ends.' })
    expect(pathOf(sketch(8, [line.loops[0]!, line.loops[0]!]), level(0))).toEqual({ why: 'Sketch 8 has 2 loops; a sweep path is one open line.' })
  })
})

describe('the picked list', () => {
  it('adds in click order, and a second click takes a sketch off', () => {
    let l: string[] = []
    for (const id of ['k1', 'k3', 'k2']) l = togglePick(l, id)
    expect(l).toEqual(['k1', 'k3', 'k2'])
    expect(togglePick(l, 'k3')).toEqual(['k1', 'k2'])
  })

  it('moves up and down, never past either end, and removes', () => {
    expect(movePick(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(movePick(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(movePick(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(movePick(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
    expect(removePick(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
  })

  it('gives the reasons Loft, Closed ring and Sweep are off, and none when they can run', () => {
    expect(loftReason(0)).toBe('Pick 2 or more sketches.')
    expect(loftReason(1)).toBe('Pick 2 or more sketches.')
    expect(loftReason(2)).toBeNull()
    expect(ringReason(2)).toBe('A closed ring needs 3 or more profiles.')
    expect(ringReason(3)).toBeNull()
    expect(sweepReason(false, false)).toBe('Pick a sketch for the profile.')
    expect(sweepReason(true, false)).toBe('Pick a sketch or an edge for the path.')
    expect(sweepReason(true, true)).toBeNull()
    expect(keptWords(2)).toBe('Profile 2 (kept in the step)')
  })

  it('keeps Loft and Sweep off in the ribbon until enough sketches are finished', () => {
    expect(sketchesOff('loft', 1)).toBe('Finish two sketches first.')
    expect(sketchesOff('loft', 2)).toBeNull()
    expect(sketchesOff('sweep', 0)).toBe('Finish a sketch first.')
    expect(sketchesOff('sweep', 1)).toBeNull()
  })

  it('hides the sketches a live loft or sweep used, and shows them again once it is rolled back', () => {
    const t = { bodies: [], items: [sketch(1, [square(10)]), sketch(2, [square(10)]), { kind: 'feature', id: 's1', body: 'b', part: 0, transform: I, params: { op: 'repair' }, uses: ['k1', 'k2'] }], marker: 3 } as unknown as Timeline
    expect(shownSketches(t)).toEqual([])
    expect(shownSketches({ ...t, marker: 2 }).map((k) => k.id)).toEqual(['k1', 'k2'])
  })
})

describe('sweep paths from edges and the start check', () => {
  const e = (a: [number, number, number], b: [number, number, number]) => ({ a, b, face: [0, 0, 1] as [number, number, number] })

  it('joins an edge chain end to end, either way round, starting at the end nearer the profile', () => {
    const r = edgePathOf([e([0, 0, 0], [10, 0, 0]), e([20, 0, 0], [10, 0, 0])], [21, 0, 0])
    expect(r).toEqual({ path: { points: [[20, 0, 0], [10, 0, 0], [0, 0, 0]] } })
  })

  it('refuses a chain that goes all the way round', () => {
    const r = edgePathOf([e([0, 0, 0], [10, 0, 0]), e([10, 0, 0], [10, 10, 0]), e([10, 10, 0], [0, 0, 0])])
    expect(r).toEqual({ why: 'That edge goes all the way round; a sweep path has two ends. Pick an open edge or a sketch.' })
  })

  it('says how far the profile sits from the path start, with the real distance', () => {
    const path = { frame: level(0), loops: [{ start: [0, 0] as [number, number], segments: [{ type: 'line' as const, to: [0, 50] as [number, number] }] }] }
    const away = { frame: { origin: [42, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 0, 1] as [number, number, number] }, loops: [circle(4)] }
    expect(offPathWords(away, path)).toBe("The profile sits 42 mm from where the path starts. Move it onto the path's start.")
    expect(offPathWords({ ...away, frame: { ...away.frame, origin: [0, 0, 0] } }, path)).toBeNull()
    expect(offPathWords(away, { points: [[42, 0, 0], [42, 50, 0]] })).toBeNull()
  })
})

describe('the step the panels record', () => {
  it('is the one loft step the design tools record for the same profiles', () => {
    const profiles = [profileOf(sketch(1, [square(20)]), level(0), 'loft'), profileOf(sketch(2, [circle(10)], level(30)), level(30), 'loft')].map((r) => ('profile' in r ? r.profile : null)!)
    expect(loftParams({ profiles, smooth: true, closed: false, operation: 'new', name: 'Loft body' })).toEqual({ op: 'sketch.loft', profiles, smooth: true, operation: 'new', name: 'Loft body' })
    const straight = loftParams({ profiles, smooth: false, closed: false, operation: 'join' })
    expect(Object.keys(straight)).toEqual(['op', 'profiles', 'operation'])
  })

  it('is the one sweep step for a profile and a path', () => {
    const profile = { frame: level(0), loops: [circle(4)] }
    const path = { points: [[0, 0, 0], [0, 0, 40]] as [number, number, number][] }
    expect(sweepParams({ profile, path, operation: 'new', name: 'Sweep body' })).toEqual({ op: 'sketch.sweep', profile, path, operation: 'new', name: 'Sweep body' })
  })

  it('matches a saved profile back to its sketch by plane and loops, else keeps it', () => {
    const ks = [sketch(1, [square(20)], level(0)), sketch(2, [square(20)], level(30))]
    const frameOf = (k: SketchItem) => k.frame ?? level(0)
    expect(matchSketch({ frame: level(30), loops: [square(20)] }, ks, frameOf)?.id).toBe('k2')
    expect(matchSketch({ frame: level(31), loops: [square(20)] }, ks, frameOf)).toBeNull()
    expect(matchSketch({ frame: level(0), loops: [square(21)] }, ks, frameOf)).toBeNull()
  })
})

// jsdom has no scrollIntoView, which a tool panel calls as it opens
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
})

const host = { slicer: { loadParts: async () => ({ id: 'h', parts: [] }) } }
const mount = (el: () => ReactElement) => render(createElement(HostContext.Provider, { value: host as never }, createElement(el)))
/** Off as a person meets it: disabled, or soft-disabled so its tip still says why. */
const off = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
const rowNames = () => screen.queryAllByTestId('loft-profile').map((r) => r.querySelector('.solid-row-name')?.textContent)

describe('the loft panel', () => {
  beforeEach(() => set({ plate: [], timeline: timeline([sketch(1, [square(20)], level(0)), sketch(2, [square(14)], level(15)), sketch(3, [square(20), circle(4)], level(30)), sketch(4, [circle(8)], level(30))]), historyEdit: null, objectTool: 'loft' }))
  afterEach(() => {
    cleanup()
    set({ objectTool: null, historyEdit: null })
  })

  it('lists picks in order with their numbers, takes one off on a second click, and reorders', () => {
    mount(LoftTool)
    expect(sketchPicker()).not.toBeNull()
    act(() => void pickSketch('k1'))
    act(() => void pickSketch('k4'))
    act(() => void pickSketch('k2'))
    expect(rowNames()).toEqual(['Sketch 1', 'Sketch 4', 'Sketch 2'])
    // the first row has nowhere up to go and the last nowhere down: those arrows are off
    const arrows = (name: string) => [screen.getByRole('button', { name: `Move ${name} up` }), screen.getByRole('button', { name: `Move ${name} down` })].map(off)
    expect([arrows('Sketch 1'), arrows('Sketch 4'), arrows('Sketch 2')]).toEqual([[true, false], [false, false], [false, true]])
    expect([...sketchPicker()!.marks]).toEqual([['k1', '1'], ['k4', '2'], ['k2', '3']])
    fireEvent.click(screen.getByRole('button', { name: 'Move Sketch 2 up' }))
    expect(rowNames()).toEqual(['Sketch 1', 'Sketch 2', 'Sketch 4'])
    act(() => void pickSketch('k2'))
    expect(rowNames()).toEqual(['Sketch 1', 'Sketch 4'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sketch 1' }))
    expect(rowNames()).toEqual(['Sketch 4'])
  })

  it('keeps Loft off under 2 picks and Closed ring off under 3, saying why', () => {
    mount(LoftTool)
    expect(off(screen.getByTestId('model-tool-apply'))).toBe(true)
    expect(screen.getByTestId('model-tool-reason').textContent).toBe('Pick 2 or more sketches.')
    expect((screen.getByTestId('loft-ring') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('loft-ring-reason').textContent).toBe('A closed ring needs 3 or more profiles.')
    act(() => void pickSketch('k1'))
    act(() => void pickSketch('k2'))
    expect(off(screen.getByTestId('model-tool-apply'))).toBe(false)
    expect(screen.queryByTestId('model-tool-reason')).toBeNull()
    act(() => void pickSketch('k4'))
    expect((screen.getByTestId('loft-ring') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('loft-ring-reason')).toBeNull()
  })

  it('refuses a sketch with two loops, naming it, and leaves the list as it was', () => {
    mount(LoftTool)
    act(() => void pickSketch('k1'))
    act(() => void pickSketch('k3'))
    expect(rowNames()).toEqual(['Sketch 1'])
    expect(screen.getByTestId('loft-message').textContent?.trim()).toBe('Sketch 3 has 2 loops; a loft profile is one closed loop.')
    // known before the press: Loft stays off with the refusal as its reason, until the list changes
    act(() => void pickSketch('k2'))
    expect(off(screen.getByTestId('model-tool-apply'))).toBe(false)
    act(() => void pickSketch('k3'))
    const apply = screen.getByTestId('model-tool-apply')
    expect(off(apply)).toBe(true)
    expect(apply.getAttribute('aria-describedby')).toBe('loft-message')
    expect(screen.queryByTestId('model-tool-reason')).toBeNull()
    // a second click on the refused sketch takes the refusal away
    act(() => void pickSketch('k3'))
    expect(screen.queryByTestId('loft-message')).toBeNull()
    expect(off(screen.getByTestId('model-tool-apply'))).toBe(false)
  })

  it('offers Join and Cut only with a body to work on', () => {
    mount(LoftTool)
    expect((screen.getByTestId('solid-result-join') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('solid-result-reason')).toBeTruthy()
  })

  it('fills from a saved step when editing it: matched sketches by name, the rest kept in the step', () => {
    const profiles = [{ frame: level(0), loops: [square(20)] }, { frame: level(15), loops: [square(14)] }, { frame: level(40), loops: [circle(6)] }]
    const step: Step = { id: 's1', part: 0, transform: I, params: { op: 'sketch.loft', profiles, smooth: true, closed: true, operation: 'new', name: 'Loft body' }, uses: ['k1', 'k2'] }
    const entry = { id: 'b1', name: 'Loft body', parts: [], colors: [], transform: I, handle: { id: 'h', parts: [] }, history: { version: 1, base: [], steps: [step] } } as unknown as PlateEntry
    set({ plate: [entry], historyEdit: { objectId: 'b1', index: 0, original: entry } as never })
    mount(LoftTool)
    expect(rowNames()).toEqual(['Sketch 1', 'Sketch 2', 'Profile 3 (kept in the step)'])
    expect((screen.getByRole('radio', { name: 'Smooth' }) as HTMLInputElement).checked || (screen.getByRole('radio', { name: 'Smooth' })).getAttribute('aria-checked') === 'true').toBe(true)
    expect((screen.getByTestId('loft-ring') as HTMLInputElement).checked || (screen.getByTestId('loft-ring')).getAttribute('aria-checked') === 'true').toBe(true)
    expect(screen.getByTestId('model-tool-crumb').textContent).toMatch(/^Loft body › /)
    expect(get().historyEdit).not.toBeNull()
  })
})

describe('the sweep panel', () => {
  beforeEach(() => set({ plate: [], timeline: timeline([sketch(1, [circle(4)], level(0)), sketch(2, [{ start: [0, 0], segments: [{ type: 'line', to: [0, 40] }] }], { origin: [0, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] })]), historyEdit: null, objectTool: 'sweep' }))
  afterEach(() => {
    cleanup()
    set({ objectTool: null, historyEdit: null })
  })

  it('fills the profile then the path, in order, and a pressed slot takes the next pick', () => {
    mount(SweepTool)
    expect(screen.getByTestId('sweep-profile').textContent).toBe('Click a sketch.')
    expect(screen.getByTestId('sweep-path').textContent).toBe('Click a sketch or an edge.')
    act(() => void pickSketch('k1'))
    expect(screen.getByTestId('sweep-profile').textContent).toBe('Sketch 1')
    expect(screen.getByTestId('sweep-path').getAttribute('aria-pressed')).toBe('true')
    act(() => void pickSketch('k2'))
    expect(screen.getByTestId('sweep-path').textContent).toBe('Sketch 2')
    expect([...sketchPicker()!.marks]).toEqual([['k1', 'Profile'], ['k2', 'Path']])
    expect(off(screen.getByTestId('model-tool-apply'))).toBe(false)
    fireEvent.click(screen.getByTestId('sweep-profile'))
    expect(screen.getByTestId('sweep-profile').getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps Sweep off before the press when the profile sits away from the path start, saying how far', () => {
    set({ timeline: timeline([sketch(1, [circle(4)], { origin: [42, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }), sketch(2, [{ start: [0, 0], segments: [{ type: 'line', to: [0, 40] }] }], { origin: [0, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] })]) })
    mount(SweepTool)
    act(() => void pickSketch('k1'))
    act(() => void pickSketch('k2'))
    const apply = screen.getByTestId('model-tool-apply')
    expect(off(apply)).toBe(true)
    expect(screen.getByTestId('sweep-message').textContent?.trim()).toBe("The profile sits 42 mm from where the path starts. Move it onto the path's start.")
    expect(apply.getAttribute('aria-describedby')).toBe('sweep-message')
  })

  it('refuses a closed sketch as the path and a two-loop sketch as the profile', () => {
    set({ timeline: timeline([sketch(1, [circle(4), square(10)], level(0)), sketch(2, [circle(4)], level(0))]) })
    mount(SweepTool)
    act(() => void pickSketch('k1'))
    expect(screen.getByTestId('sweep-message').textContent?.trim()).toBe('Sketch 1 has 2 loops; a sweep profile is one closed loop.')
    act(() => void pickSketch('k2'))
    fireEvent.click(screen.getByTestId('sweep-path'))
    act(() => void pickSketch('k2'))
    expect(screen.getByTestId('sweep-message').textContent?.trim()).toBe('Sketch 2 is closed; a sweep path is one open line with two ends.')
  })

  it('fills from a saved step when editing it, an edge path kept in the step', () => {
    const step: Step = { id: 's1', part: 0, transform: I, params: { op: 'sketch.sweep', profile: { frame: level(0), loops: [circle(4)] }, path: { points: [[0, 0, 0], [0, 0, 40]] }, operation: 'new', name: 'Sweep body' } }
    const entry = { id: 'b1', name: 'Sweep body', parts: [], colors: [], transform: I, handle: { id: 'h', parts: [] }, history: { version: 1, base: [], steps: [step] } } as unknown as PlateEntry
    set({ plate: [entry], historyEdit: { objectId: 'b1', index: 0, original: entry } as never })
    mount(SweepTool)
    expect(screen.getByTestId('sweep-profile').textContent).toBe('Sketch 1')
    expect(screen.getByTestId('sweep-path').textContent).toBe('Kept in the step')
    expect(off(screen.getByTestId('model-tool-apply'))).toBe(false)
  })
})
