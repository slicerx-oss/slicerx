// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag (@slicerx/viewport/edge-drag): the commit line (whole footprint past the edge plus 8 mm or 24 px, at
// the view's scale), which edge a move goes out over (corners, a group), the room each edge needs and the zoom that
// gives it, which plate each side offers, and the overlay that exists only while a part moves, with a host that
// records what it is asked to do.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EdgeDragInfo } from '../src/types'
import { enableEdgeDrag, loadEdgeDrag, overlayInsets, overlaysMounted, resetHint, type EdgeDragDestination, type EdgeDragOptions, type EdgeDragViewport } from '../src/edge-drag'
import { commitMarginMm, edgeReach, fitScale, glow, groupBox, onBed, readEdges, reachPastLineMm, roomNeeded, sidesOf, sideTargets, targetLabel, visibleArea, armedMessage, type BedEdge, type Box2 } from '../src/edge-drag/geometry'
import { mmPerPxAt } from '../src/edge-drag/reach'
import type { EdgeDragHook } from '../src/types'

const BED = { widthMm: 180, depthMm: 180 }
const ALL: BedEdge[] = ['x-', 'x+', 'y-', 'y+']
const box = (x0: number, y0: number, x1: number, y1: number): Box2 => ({ min: [x0, y0], max: [x1, y1] })

describe('the commit line', () => {
  it('is 8 mm past the edge, or 24 screen pixels when those are more, so zooming out moves it further', () => {
    // close in: 0.1 mm a pixel, 24 px is 2.4 mm, so 8 mm holds
    expect(commitMarginMm(0.1)).toBe(8)
    // exactly where the two meet
    expect(commitMarginMm(8 / 24)).toBeCloseTo(8)
    // zoomed out: 0.5 mm a pixel, 24 px is 12 mm
    expect(commitMarginMm(0.5)).toBeCloseTo(12)
    expect(commitMarginMm(2)).toBeCloseTo(48)
    // a view that cannot say its scale keeps the 8 mm floor
    expect(commitMarginMm(0)).toBe(8)
    expect(commitMarginMm(Number.NaN)).toBe(8)
  })

  it('needs the whole footprint past the edge plus the margin; a part straddling the edge is not armed', () => {
    const m = commitMarginMm(0.1)
    // a 20 mm part with its near side 7.9 mm past the right edge: past the edge, short of the line
    const short = readEdges(box(180 + 7.9, 50, 200 + 7.9, 70), BED, ALL, m)
    expect(short.edge).toBe('x+')
    expect(short.armed).toBe(false)
    const armed = readEdges(box(188, 50, 208, 70), BED, ALL, m)
    expect(armed.armed).toBe(true)
    // half of it past the edge
    const half = readEdges(box(170, 50, 190, 70), BED, ALL, m)
    expect(half.edge).toBe('x+')
    expect(half.armed).toBe(false)
    expect(half.lead).toBeCloseTo(10)
    expect(half.trail).toBeCloseTo(-10)
  })

  it('a normal move up to the edge, or right against it, never arms anything', () => {
    for (const b of [box(160, 10, 180, 30), box(0, 0, 20, 20), box(80, 160, 100, 180), box(10, 10, 170, 170)]) {
      const r = readEdges(b, BED, ALL, 8)
      expect(r.edge).toBeNull()
      expect(r.armed).toBe(false)
      expect(onBed(b, BED)).toBe(true)
    }
    expect(onBed(box(161, 10, 181, 30), BED)).toBe(false)
  })

  it('uses the view scale in millimeters per pixel: a closer view keeps 8 mm, a far one needs 24 px', () => {
    // a view at 4 px a mm (close) and one at 1 px for 2 mm (far)
    const close = mmPerPxAt((p) => [p[0] * 4, p[1] * 4], [90, 90], [1, 0])
    const far = mmPerPxAt((p) => [p[0] / 2, p[1] / 2], [90, 90], [1, 0])
    expect(close).toBeCloseTo(0.25)
    expect(far).toBeCloseTo(2)
    const footprint = box(180 + 20, 50, 200 + 20, 70)
    // 20 mm out: past an 8 mm line up close, short of the 48 mm line from far away
    expect(readEdges(footprint, BED, ALL, commitMarginMm(close)).armed).toBe(true)
    expect(readEdges(footprint, BED, ALL, commitMarginMm(far)).armed).toBe(false)
    expect(readEdges(box(180 + 48, 50, 200 + 48, 70), BED, ALL, commitMarginMm(far)).armed).toBe(true)
    // the room past the line follows the scale too
    expect(reachPastLineMm(0.1)).toBe(12)
    expect(reachPastLineMm(1)).toBe(64)
  })

  it('reads the margin of the edge the part goes out over', () => {
    const b = box(-30, 50, -10, 70)
    expect(readEdges(b, BED, ALL, { 'x-': 12, 'x+': 8 }).armed).toBe(false)
    expect(readEdges(b, BED, ALL, { 'x-': 10, 'x+': 40 }).armed).toBe(true)
  })
})

describe('which edge', () => {
  it('picks the edge in each direction', () => {
    expect(readEdges(box(-40, 60, -20, 80), BED, ALL, 8)).toMatchObject({ edge: 'x-', armed: true })
    expect(readEdges(box(200, 60, 220, 80), BED, ALL, 8)).toMatchObject({ edge: 'x+', armed: true })
    expect(readEdges(box(60, -40, 80, -20), BED, ALL, 8)).toMatchObject({ edge: 'y-', armed: true })
    expect(readEdges(box(60, 200, 80, 220), BED, ALL, 8)).toMatchObject({ edge: 'y+', armed: true })
  })

  it('at a corner, the edge the part is further past wins, and only that one can be armed', () => {
    // 30 mm past the right edge and 12 mm past the back: right
    const r = readEdges(box(200, 182, 210, 192), BED, ALL, 8)
    expect(r.edge).toBe('x+')
    expect(r.armed).toBe(true)
    // further past the back: back, armed only if all of it is past the back's line
    const b = readEdges(box(176, 200, 186, 220), BED, ALL, 8)
    expect(b.edge).toBe('y+')
    expect(b.armed).toBe(true)
    const straddle = readEdges(box(176, 182, 186, 220), BED, ALL, 8)
    expect(straddle.edge).toBe('y+')
    expect(straddle.armed).toBe(false)
  })

  it('only the edges on offer count: with one plate only the new plate edge does', () => {
    expect(readEdges(box(200, 60, 220, 80), BED, ['y-'], 8).edge).toBeNull()
    expect(readEdges(box(60, -40, 80, -20), BED, ['y-'], 8)).toMatchObject({ edge: 'y-', armed: true })
  })

  it('a multi-selection moves as one group, and the whole group must be past the line', () => {
    const one = box(200, 40, 220, 60)
    const two = box(170, 90, 190, 110)
    const g = groupBox([one, two])!
    expect(g).toEqual(box(170, 40, 220, 110))
    expect(readEdges(g, BED, ALL, 8)).toMatchObject({ edge: 'x+', armed: false })
    const both = groupBox([one, box(195, 90, 215, 110)])!
    expect(readEdges(both, BED, ALL, 8)).toMatchObject({ edge: 'x+', armed: true })
    expect(groupBox([])).toBeNull()
  })

  it('reaches past each edge by the far and near sides of the footprint', () => {
    expect(edgeReach(box(170, 0, 190, 10), BED, 'x+')).toEqual({ lead: 10, trail: -10, size: 20 })
    expect(edgeReach(box(-5, 0, 15, 10), BED, 'x-')).toEqual({ lead: 5, trail: -15, size: 20 })
    expect(edgeReach(box(0, -12, 10, -2), BED, 'y-')).toEqual({ lead: 12, trail: 2, size: 10 })
    expect(edgeReach(box(0, 175, 10, 185), BED, 'y+')).toEqual({ lead: 5, trail: -5, size: 10 })
  })

  it('glows faintly at the start, brighter the further out, full once armed', () => {
    const levels = [-40, -10, 0, 10, 20, 27].map((lead) => glow(lead, 20, 8, false).level)
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThanOrEqual(levels[i - 1]!)
    expect(levels[0]).toBeCloseTo(0.16)
    expect(glow(30, 20, 8, true).level).toBe(1)
  })
})

describe('room past each edge', () => {
  // a 1440 x 900 window with the 3D view between two side panes (420..1110), the toolbar and the plate bar over it
  const win = { width: 1440, height: 900 }
  const stage = { left: 420, top: 68, right: 1110, bottom: 856 }
  const toolbar = { left: 560, top: 82, right: 972, bottom: 124 }
  const plateBar = { left: 434, top: 802, right: 872, bottom: 842 }
  // a part of 20 mm at 0.4 mm a pixel, which a drag may take 9.6 + 25.6 mm past the edge, needs 138 + 24 px past it
  const need = roomNeeded(20, commitMarginMm(0.4) + reachPastLineMm(0.4), 0.4)

  it('needs the part and the furthest a drag may take it past the edge, at the view scale', () => {
    expect(need).toBeCloseTo(162)
    expect(roomNeeded(20, 8, 0.2)).toBeCloseTo(164)
    expect(roomNeeded(20, 8, 0.2, 0)).toBeCloseTo(140)
  })

  it('the visible area is the view inside the window, less the bars over it', () => {
    const open = visibleArea(stage, win, overlayInsets(stage, [toolbar, plateBar]))
    expect(open.left).toBe(420)
    expect(open.right).toBe(1110)
    expect(open.top).toBeGreaterThan(124)
    expect(open.bottom).toBeLessThan(802)
    // a view wider than the window is cut at the window
    expect(visibleArea({ left: -20, top: 0, right: 500, bottom: 900 }, { width: 390, height: 844 }, { left: 0, right: 0, top: 0, bottom: 0 })).toEqual({ left: 0, top: 0, right: 390, bottom: 844 })
  })

  it('eases out when an edge lacks room, and not when every edge has it', () => {
    const edges = (rightX: number) => [
      { mid: [rightX, 470] as const, n: [1, 0] as const, need },
      { mid: [600, 470] as const, n: [-1, 0] as const, need },
    ]
    const vis = visibleArea(stage, win, overlayInsets(stage, [toolbar, plateBar]))
    // the bed's right edge 90 px from the view's edge: about 70 px short
    const tight = fitScale(vis, [765, 470], edges(1020), 0.45)
    expect(tight).toBeLessThan(1)
    // at that scale the right edge's middle has the room
    expect(vis.right - (765 + tight * (1020 - 765))).toBeGreaterThanOrEqual(tight * need - 0.5)
    // plenty of room: no zoom
    expect(fitScale(vis, [765, 470], edges(900), 0.45)).toBe(1)
  })

  it('a panel floating over the view takes room; closed, the room is back', () => {
    const panel = { left: 900, top: 140, right: 1100, bottom: 700 }
    const edges = [{ mid: [900, 470] as const, n: [1, 0] as const, need }]
    const closed = fitScale(visibleArea(stage, win, overlayInsets(stage, [])), [765, 470], edges, 0.45)
    const open = fitScale(visibleArea(stage, win, overlayInsets(stage, [panel])), [765, 470], edges, 0.45)
    expect(closed).toBe(1)
    expect(open).toBeLessThan(0.75)
    // never further out than the floor
    expect(fitScale({ left: 0, top: 0, right: 10, bottom: 10 }, [5, 5], edges, 0.45)).toBe(0.45)
  })
})

describe('screen sides', () => {
  it('a view from the front puts the back edge on top and the front at the bottom', () => {
    expect(sidesOf({ 'x-': [-1, 0], 'x+': [1, 0], 'y-': [0, 1], 'y+': [0, -1] })).toEqual({ 'x-': 'left', 'x+': 'right', 'y-': 'bottom', 'y+': 'top' })
  })

  it('a turned view still gives each edge its own side', () => {
    const r = Math.SQRT1_2
    // turned 30 degrees, and at exactly 45, where two edges are equally near two sides
    const turned = sidesOf({ 'x-': [-0.87, -0.5], 'x+': [0.87, 0.5], 'y-': [-0.5, 0.87], 'y+': [0.5, -0.87] })
    expect(new Set(Object.values(turned)).size).toBe(4)
    expect(turned['x+']).toBe('right')
    const diag = sidesOf({ 'x-': [-r, -r], 'x+': [r, r], 'y-': [-r, r], 'y+': [r, -r] })
    expect(new Set(Object.values(diag)).size).toBe(4)
    // seen from behind, left and right swap
    expect(sidesOf({ 'x-': [1, 0], 'x+': [-1, 0], 'y-': [0, -1], 'y+': [0, 1] })).toEqual({ 'x-': 'right', 'x+': 'left', 'y-': 'top', 'y+': 'bottom' })
  })
})

describe('what each side offers', () => {
  const plates = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, label: `Plate ${i + 1}`, order: i }))

  it('one plate: only the bottom, a new plate', () => {
    expect(sideTargets(plates(1), 'p1')).toEqual({ bottom: { kind: 'new' } })
  })

  it('the other plates in plate order take left, top and right; the bottom is always a new plate', () => {
    const t = sideTargets(plates(4), 'p2')
    expect(t.left).toEqual({ kind: 'plate', plate: { id: 'p1', label: 'Plate 1', order: 0 } })
    expect(t.top).toEqual({ kind: 'plate', plate: { id: 'p3', label: 'Plate 3', order: 2 } })
    expect(t.right).toEqual({ kind: 'plate', plate: { id: 'p4', label: 'Plate 4', order: 3 } })
    expect(t.bottom).toEqual({ kind: 'new' })
    expect(Object.keys(sideTargets(plates(2), 'p1')).sort()).toEqual(['bottom', 'left'])
    expect(sideTargets(plates(3), 'p1')).toMatchObject({ left: { plate: { label: 'Plate 2' } }, top: { plate: { label: 'Plate 3' } } })
  })

  it('past three other plates the top edge becomes More plates with the rest', () => {
    const t = sideTargets(plates(7), 'p2')
    expect(t.left).toMatchObject({ plate: { label: 'Plate 1' } })
    expect(t.right).toMatchObject({ plate: { label: 'Plate 3' } })
    expect(t.top).toEqual({ kind: 'more', plates: [4, 5, 6, 7].map((n) => ({ id: `p${n}`, label: `Plate ${n}`, order: n - 1 })) })
    expect(targetLabel(t.top!)).toBe('+ More plates')
  })

  it('labels and live text', () => {
    expect(targetLabel({ kind: 'plate', plate: { id: 'p3', label: 'Plate 3', order: 2 } })).toBe('+ Add to Plate 3')
    expect(targetLabel({ kind: 'new' })).toBe('+ Add to new plate')
    expect(armedMessage({ kind: 'plate', plate: { id: 'p3', label: 'Plate 3', order: 2 } })).toBe('Release to add to Plate 3')
    expect(armedMessage({ id: 'p5', label: 'Plate 5', order: 4 })).toBe('Release to add to Plate 5')
    expect(armedMessage({ kind: 'new' })).toBe('Release to add to a new plate')
  })
})

describe('the overlay while idle and while a part moves', () => {
  // a top view, 3 px a mm, the bed at 200..740 x 130..670 (y flipped: the back is at the top)
  const screenOf = (p: [number, number, number]): [number, number] => [200 + p[0] * 3, 670 - p[1] * 3]
  const info = (x0: number, y0: number, x1: number, y1: number, ids = ['a']): EdgeDragInfo => ({ ids, box: { min: [x0, y0], max: [x1, y1] }, client: [200 + ((x0 + x1) / 2) * 3, 670 - ((y0 + y1) / 2) * 3], pointerType: 'mouse', bed: BED })

  /** A view stand-in that keeps the hook it is given, and a host that records what it is asked. */
  function setup(extra: Partial<EdgeDragOptions> = {}, view: Partial<EdgeDragViewport> = {}) {
    const stage = document.createElement('div')
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    const canvas = document.createElement('canvas')
    stage.appendChild(canvas)
    document.body.appendChild(stage)
    let hook: EdgeDragHook | null = null
    const moves: [readonly string[], EdgeDragDestination][] = []
    const switched: [string, readonly string[]][] = []
    let active = 'plate-1'
    const plates = [
      { id: 'plate-1', label: 'Plate 1', order: 0 },
      { id: 'plate-2', label: 'Plate 2', order: 1 },
    ]
    const vp = { canvas, setSelection: vi.fn(), setEdgeDrag: (h: EdgeDragHook | null) => (hook = h), screenOf, ...view } as unknown as EdgeDragViewport
    const off = enableEdgeDrag(vp, {
      plates: () => plates,
      activePlate: () => active,
      move: (ids, dest) => {
        moves.push([ids, dest])
      },
      onSwitch: (id, ids) => {
        active = id
        switched.push([id, ids])
      },
      ...extra,
    })
    return { stage, hook: () => hook!, moves, switched, off }
  }

  beforeEach(() => {
    document.documentElement.dataset['motion'] = 'reduced'
  })
  afterEach(() => {
    delete document.documentElement.dataset['motion']
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('costs nothing until a part moves: no overlay, no frames, no listeners; and leaves nothing after', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const listen = vi.spyOn(window, 'addEventListener')
    const { stage, hook, off } = setup()
    // idle: set on the view, nothing drawn, scheduled or listened for
    await new Promise((r) => setTimeout(r, 20))
    expect(stage.querySelector('.sx-edge-drag')).toBeNull()
    expect(raf).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
    expect(overlaysMounted()).toBe(0)
    // a move starts: the overlay comes up once the gesture code is in
    expect(hook().start(info(30, 30, 50, 50))).toBe(true)
    await loadEdgeDrag()
    await new Promise((r) => setTimeout(r, 0))
    expect(overlaysMounted()).toBe(1)
    expect(stage.querySelector('[data-testid="edge-drag"]')).not.toBeNull()
    expect(stage.querySelectorAll('.sx-edge-label')).toHaveLength(2)
    expect(listen).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    // released on the bed: a normal move; the overlay goes and frames stop
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const remove = vi.spyOn(window, 'removeEventListener')
    expect(hook().end({ ...info(60, 60, 80, 80), onBed: true })).toBe('back')
    expect(overlaysMounted()).toBe(0)
    expect(stage.querySelector('.sx-edge-drag')).toBeNull()
    expect(cancel).toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    // idle again: no more frames are asked for
    const calls = raf.mock.calls.length
    await new Promise((r) => setTimeout(r, 40))
    expect(raf.mock.calls.length).toBe(calls)
    off()
  })

  it('arms past the line with a solid line, an underlined label and a polite live message, and asks the host to move on release', async () => {
    await loadEdgeDrag()
    const { stage, hook, moves, switched } = setup()
    hook().start(info(30, 30, 50, 50))
    await new Promise((r) => setTimeout(r, 0))
    // left edge offers Plate 2; part half off the left edge: not armed
    hook().move(info(-10, 30, 10, 50))
    expect(hook().reachMm()).toBeGreaterThanOrEqual(8 + 12)
    const live = stage.querySelector('[data-testid="edge-drag-live"]')!
    expect(live.getAttribute('aria-live')).toBe('polite')
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(stage.querySelector('[data-testid="edge-drag-left"]')!.hasAttribute('data-armed')).toBe(false)
    // all of it 9 mm past the edge (3 px a mm: 24 px is 8 mm, so the line is at 8 mm)
    hook().move(info(-29, 30, -9, 50))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(stage.querySelector('[data-testid="edge-drag-left"]')!.hasAttribute('data-armed')).toBe(true)
    expect(stage.querySelector('.sx-edge-commit[data-armed]')).not.toBeNull()
    expect(live.textContent).toBe('Release to add to Plate 2')
    expect(hook().end({ ...info(-29, 30, -9, 50), onBed: false })).toBe('commit')
    expect(moves).toEqual([[['a'], { plate: 'plate-2' }]])
    // reduced motion: dropped at once, then the host shows Plate 2 with the part selected
    await new Promise((r) => setTimeout(r, 0))
    expect(switched).toEqual([['plate-2', ['a']]])
    expect(stage.querySelector('.sx-edge-drag')).toBeNull()
  })

  it('a release short of the line goes back with a one-time hint; Esc calls the drag off', async () => {
    await loadEdgeDrag()
    resetHint()
    const cancelDrag = vi.fn(() => true)
    const { stage, hook, moves } = setup({}, { cancelDrag })
    hook().start(info(30, 30, 50, 50))
    await new Promise((r) => setTimeout(r, 0))
    hook().move(info(-5, 30, 15, 50))
    expect(hook().end({ ...info(-5, 30, 15, 50), onBed: false })).toBe('back')
    expect(stage.querySelector('[data-testid="edge-drag-hint"]')!.textContent).toBe('Drag past the line to move it')
    // the hint shows once
    hook().start(info(30, 30, 50, 50))
    await new Promise((r) => setTimeout(r, 0))
    expect(hook().end({ ...info(-5, 30, 15, 50), onBed: false })).toBe('back')
    expect(stage.querySelectorAll('[data-testid="edge-drag-hint"]')).toHaveLength(1)
    // Esc during a move asks the view to call it off
    hook().start(info(30, 30, 50, 50))
    await new Promise((r) => setTimeout(r, 0))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(cancelDrag).toHaveBeenCalledTimes(1)
    hook().cancel()
    expect(moves).toEqual([])
  })

  it('declines what the host will not move, and a quick release before the gesture code arrives goes back', async () => {
    const { stage, hook } = setup({ canMove: (ids) => !ids.includes('tower') })
    expect(hook().start(info(30, 30, 50, 50, ['tower']))).toBe(false)
    expect(hook().start(info(30, 30, 50, 50))).toBe(true)
    expect(hook().end({ ...info(-40, 30, -20, 50), onBed: false })).toBe('back')
    await new Promise((r) => setTimeout(r, 10))
    expect(stage.querySelector('.sx-edge-drag')).toBeNull()
  })
})
