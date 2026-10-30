// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag from a host's side, with no app around it: a stand-in view and two parts, four plates, and a host
// that records each move. The stand-in plays the view's part of a drag (start, moves, release, Esc) the way the real
// view calls the hook. Covers each edge's destination, a short release, Esc, a group, the idle cost, labels and theme.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { EdgeDragHook, EdgeDragInfo } from '../src/types'
import { DEFAULT_EDGE_DRAG_LABELS, EDGE_DRAG_PROPERTIES, enableEdgeDrag, loadEdgeDrag, overlaysMounted, resetHint, type EdgeDragDestination, type EdgeDragOptions } from '../src/edge-drag/index'

const BED = { widthMm: 180, depthMm: 180 }
// a top view at 3 px a mm, the bed at 200..740 x 130..670 with its back at the top
const screenOf = (p: [number, number, number]): [number, number] => [200 + p[0] * 3, 670 - p[1] * 3]

/** A footprint as the view reports it. */
function info(x0: number, y0: number, x1: number, y1: number, ids: string[] = ['a'], pointerType = 'mouse'): EdgeDragInfo {
  return { ids, box: { min: [x0, y0], max: [x1, y1] }, client: [200 + ((x0 + x1) / 2) * 3, 670 - ((y0 + y1) / 2) * 3], pointerType, bed: BED } as EdgeDragInfo
}

/** The stand-in view: a canvas in a positioned stage, and the calls the gesture makes. */
function standInView() {
  const stage = document.createElement('div')
  stage.style.position = 'relative'
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) })
  const canvas = document.createElement('canvas')
  stage.appendChild(canvas)
  document.body.appendChild(stage)
  let hook: EdgeDragHook | null = null
  const view = {
    canvas,
    screenOf,
    setEdgeDrag: vi.fn((h: EdgeDragHook | null) => {
      hook = h
    }),
    cancelDrag: vi.fn(() => {
      // the real view puts the parts back and tells the hook
      if (!hook) return false
      hook.cancel()
      return true
    }),
    setDragZoom: vi.fn(),
    placeReadout: vi.fn(),
    setSelection: vi.fn(),
    // the camera is held through what runs inside
    keepCamera: vi.fn((change: () => unknown) => change()) as Mock<(change: () => unknown) => unknown> & (<T>(change: () => T) => T),
    showSelection: vi.fn(() => false),
  }
  return { stage, canvas, view, hook: () => hook }
}

/** A host with four plates; Plate 1 shows. */
function host(extra: Partial<EdgeDragOptions> = {}) {
  const plates = [1, 2, 3, 4].map((n) => ({ id: `plate-${n}`, label: `Plate ${n}`, order: n - 1 }))
  const moves: { ids: string[]; dest: EdgeDragDestination }[] = []
  const switches: { plate: string; ids: string[] }[] = []
  const options: EdgeDragOptions = {
    plates: () => plates,
    activePlate: () => 'plate-1',
    move: (ids, dest) => {
      moves.push({ ids: [...ids], dest })
      if (dest === 'new') {
        plates.push({ id: `plate-${plates.length + 1}`, label: `Plate ${plates.length + 1}`, order: plates.length })
        return plates[plates.length - 1]!.id
      }
    },
    onSwitch: (plate, ids) => switches.push({ plate, ids: [...ids] }),
    ...extra,
  }
  return { options, plates, moves, switches }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
const q = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)

/** Starts a move and waits for the gesture code and its overlay. */
async function begin(hook: EdgeDragHook, first = info(30, 30, 50, 50)) {
  expect(hook.start(first)).toBe(true)
  await loadEdgeDrag()
  await tick()
}

beforeEach(() => {
  // reduced motion: the drop and the settle are instant, so each release is final at once
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }))
  resetHint()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
})

describe('a stand-in host', () => {
  it('costs nothing while idle: no overlay, frames or listeners until a part moves, and none after', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const listen = vi.spyOn(window, 'addEventListener')
    const docListen = vi.spyOn(document, 'addEventListener')
    const { stage, view, hook } = standInView()
    const { options } = host()
    const off = enableEdgeDrag(view, options)
    expect(view.setEdgeDrag).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(stage.childElementCount).toBe(1)
    expect(raf).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
    expect(docListen).not.toHaveBeenCalled()
    expect(overlaysMounted()).toBe(0)

    await begin(hook()!)
    expect(overlaysMounted()).toBe(1)
    expect(q(stage, 'edge-drag')).not.toBeNull()
    expect(listen).toHaveBeenCalledWith('keydown', expect.any(Function), true)

    const stopFrames = vi.spyOn(window, 'cancelAnimationFrame')
    const unlisten = vi.spyOn(window, 'removeEventListener')
    // released on the bed: a normal move, and the overlay goes
    expect(hook()!.end({ ...info(60, 60, 80, 80), onBed: true })).toBe('back')
    expect(overlaysMounted()).toBe(0)
    expect(stage.childElementCount).toBe(1)
    expect(stopFrames).toHaveBeenCalled()
    expect(unlisten).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    const asked = raf.mock.calls.length
    await new Promise((r) => setTimeout(r, 40))
    expect(raf.mock.calls.length).toBe(asked)

    off()
    expect(view.setEdgeDrag).toHaveBeenLastCalledWith(null)
  })

  it('offers the other plates in plate order on the left, top and right, and a new plate at the bottom', async () => {
    const { stage, view, hook } = standInView()
    enableEdgeDrag(view, host().options)
    await begin(hook()!)
    expect(q(stage, 'edge-drag-left')!.textContent).toBe('+ Add to Plate 2')
    expect(q(stage, 'edge-drag-top')!.textContent).toBe('+ Add to Plate 3')
    expect(q(stage, 'edge-drag-right')!.textContent).toBe('+ Add to Plate 4')
    expect(q(stage, 'edge-drag-bottom')!.textContent).toBe('+ Add to new plate')
    hook()!.cancel()
  })

  // each edge, the footprint all of it 9 mm out (the line is 8 mm at 3 px a mm), and where the host is asked to move it
  const edges: [string, EdgeDragInfo, EdgeDragDestination, string][] = [
    ['right', info(189, 30, 209, 50), { plate: 'plate-4' }, 'Release to add to Plate 4'],
    ['left', info(-29, 30, -9, 50), { plate: 'plate-2' }, 'Release to add to Plate 2'],
    ['top', info(30, 189, 50, 209), { plate: 'plate-3' }, 'Release to add to Plate 3'],
    ['bottom', info(30, -29, 50, -9), 'new', 'Release to add to a new plate'],
  ]
  for (const [side, past, dest, said] of edges) {
    it(`a release past the ${side} line moves the part, says so first, and shows where it went`, async () => {
      const { stage, view, hook } = standInView()
      const h = host({ dropTarget: () => new DOMRect(400, 760, 160, 32) })
      enableEdgeDrag(view, h.options)
      await begin(hook()!)
      hook()!.move(past)
      await frame()
      expect(q(stage, `edge-drag-${side}`)!.hasAttribute('data-armed')).toBe(true)
      const live = q(stage, 'edge-drag-live')!
      expect(live.getAttribute('aria-live')).toBe('polite')
      expect(live.textContent).toBe(said)
      expect(hook()!.end({ ...past, onBed: false })).toBe('commit')
      expect(h.moves).toEqual([{ ids: ['a'], dest }])
      await tick()
      const went = dest === 'new' ? 'plate-5' : dest.plate
      expect(h.switches).toEqual([{ plate: went, ids: ['a'] }])
      expect(view.setSelection).toHaveBeenCalledWith(['a'])
      // reduced motion: dropped at once, nothing left; a plate bar marks the plate, so no note and the view reframes
      expect(overlaysMounted()).toBe(0)
      expect(q(stage, 'edge-drag')).toBeNull()
      expect(view.keepCamera).not.toHaveBeenCalled()
    })
  }

  it('with no plate bar to fly to, the plate shows at once in the same framing, and the host says where it went', async () => {
    const { stage, view, hook } = standInView()
    const said: [string, string][] = []
    let held = 0
    view.keepCamera.mockImplementation((change: () => unknown) => {
      held++
      try {
        return change()
      } finally {
        held--
      }
    })
    const h = host({ dropTarget: () => null, notify: (text, plate) => said.push([text, plate]) })
    const moveHeld: number[] = []
    const switchHeld: number[] = []
    const move = h.options.move
    h.options.move = (ids, dest) => {
      moveHeld.push(held)
      return move(ids, dest)
    }
    const onSwitch = h.options.onSwitch!
    h.options.onSwitch = (plate, ids) => {
      switchHeld.push(held)
      onSwitch(plate, ids)
    }
    enableEdgeDrag(view, h.options)
    await begin(hook()!)
    const past = info(189, 30, 209, 50)
    hook()!.move(past)
    await frame()
    expect(hook()!.end({ ...past, onBed: false })).toBe('commit')
    await tick()
    expect(h.switches).toEqual([{ plate: 'plate-4', ids: ['a'] }])
    // the move and the switch run with the camera held, then the view only slides to the part if it is out of sight
    expect(moveHeld).toEqual([1])
    expect(switchHeld).toEqual([1])
    expect(view.showSelection).toHaveBeenCalledWith(expect.objectContaining({ keepZoom: true }))
    expect(said).toEqual([['Moved to Plate 4', 'plate-4']])
    expect(overlaysMounted()).toBe(0)
    expect(q(stage, 'edge-drag')).toBeNull()
  })

  it('with no plate bar and no notify, the overlay says where it went for a moment, then goes', async () => {
    const { stage, view, hook } = standInView()
    const h = host()
    enableEdgeDrag(view, h.options)
    await begin(hook()!)
    const past = info(30, -29, 50, -9)
    hook()!.move(past)
    await frame()
    expect(hook()!.end({ ...past, onBed: false })).toBe('commit')
    await tick()
    expect(h.switches).toEqual([{ plate: 'plate-5', ids: ['a'] }])
    const note = q(stage, 'edge-drag-note')!
    expect(note.textContent).toBe('Moved to Plate 5')
    expect(note.getAttribute('role')).toBe('status')
    await vi.waitFor(() => expect(overlaysMounted()).toBe(0), { timeout: 3_000 })
    expect(q(stage, 'edge-drag')).toBeNull()
  })

  it('a release short of the line moves nothing, the part goes back, and a hint shows once', async () => {
    const { stage, view, hook } = standInView()
    const h = host()
    enableEdgeDrag(view, h.options)
    await begin(hook()!)
    // past the right edge, 5 mm short of the line
    const short = info(183, 30, 203, 50)
    hook()!.move(short)
    await frame()
    expect(q(stage, 'edge-drag-right')!.hasAttribute('data-armed')).toBe(false)
    expect(hook()!.end({ ...short, onBed: false })).toBe('back')
    expect(h.moves).toEqual([])
    expect(q(stage, 'edge-drag-hint')!.textContent).toBe('Drag past the line to move it')
    await begin(hook()!)
    expect(hook()!.end({ ...short, onBed: false })).toBe('back')
    expect(stage.querySelectorAll('[data-testid="edge-drag-hint"]')).toHaveLength(1)
    expect(h.moves).toEqual([])
    // the hint goes by itself, and the overlay with it
    await new Promise((r) => setTimeout(r, 1900))
    expect(overlaysMounted()).toBe(0)
    expect(q(stage, 'edge-drag')).toBeNull()
  })

  it('a quick release before the gesture code arrives goes back and moves nothing', async () => {
    const { view, hook } = standInView()
    const h = host()
    enableEdgeDrag(view, h.options)
    expect(hook()!.start(info(30, 30, 50, 50))).toBe(true)
    expect(hook()!.end({ ...info(189, 30, 209, 50), onBed: false })).toBe('back')
    await loadEdgeDrag()
    await tick()
    expect(h.moves).toEqual([])
    expect(overlaysMounted()).toBe(0)
  })

  it('Esc calls the move off through the view, and a later release moves nothing', async () => {
    const { stage, view, hook } = standInView()
    const h = host()
    enableEdgeDrag(view, h.options)
    await begin(hook()!)
    hook()!.move(info(189, 30, 209, 50))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(view.cancelDrag).toHaveBeenCalledTimes(1)
    expect(overlaysMounted()).toBe(0)
    expect(q(stage, 'edge-drag')).toBeNull()
    expect(hook()!.end({ ...info(189, 30, 209, 50), onBed: false })).toBe('back')
    expect(h.moves).toEqual([])
  })

  it('Esc with a view that cannot cancel still takes the overlay away', async () => {
    const { stage, view, hook } = standInView()
    const h = host()
    enableEdgeDrag({ ...view, cancelDrag: undefined }, h.options)
    await begin(hook()!)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(overlaysMounted()).toBe(0)
    expect(q(stage, 'edge-drag')).toBeNull()
    expect(h.moves).toEqual([])
  })

  it('a selection moves as one group, and only once all of it is past the line', async () => {
    const { stage, view, hook } = standInView()
    const h = host()
    enableEdgeDrag(view, h.options)
    await begin(hook()!, info(30, 30, 110, 50, ['a', 'b']))
    // part b still straddles the line
    const straddle = info(185, 30, 265, 50, ['a', 'b'])
    hook()!.move(straddle)
    await frame()
    expect(q(stage, 'edge-drag-right')!.hasAttribute('data-armed')).toBe(false)
    hook()!.move(info(190, 30, 270, 50, ['a', 'b']))
    await frame()
    expect(q(stage, 'edge-drag-right')!.hasAttribute('data-armed')).toBe(true)
    expect(hook()!.end({ ...info(190, 30, 270, 50, ['a', 'b']), onBed: false })).toBe('commit')
    expect(h.moves).toEqual([{ ids: ['a', 'b'], dest: { plate: 'plate-4' } }])
    await tick()
    expect(h.switches).toEqual([{ plate: 'plate-4', ids: ['a', 'b'] }])
    // no plate bar here: the note says where the group went, and then the overlay goes
    expect(q(stage, 'edge-drag-note')!.textContent).toBe('Moved to Plate 4')
    await vi.waitFor(() => expect(overlaysMounted()).toBe(0), { timeout: 3_000 })
  })

  it('canMove false keeps the move on the bed', async () => {
    const { view, hook } = standInView()
    const h = host({ canMove: (ids) => !ids.includes('tower') })
    enableEdgeDrag(view, h.options)
    expect(hook()!.start(info(30, 30, 50, 50, ['tower']))).toBe(false)
    expect(overlaysMounted()).toBe(0)
  })

  it('a touch drag eases the view out, keeps clear of the host bars it is given, and eases back after', async () => {
    const { view, hook } = standInView()
    const obstacles = vi.fn(() => [new DOMRect(0, 0, 1000, 48)])
    enableEdgeDrag(view, host({ obstacles }).options)
    await begin(hook()!, info(30, 30, 50, 50, ['a'], 'touch'))
    expect(obstacles).toHaveBeenCalled()
    const scale = view.setDragZoom.mock.calls[0]![0] as number
    expect(scale).toBeLessThanOrEqual(0.72)
    hook()!.cancel()
    expect(view.setDragZoom).toHaveBeenLastCalledWith(null, expect.any(Number))
  })

  it('a finger heading for a side with too little room slides the view away from it, a drag still short of the line', async () => {
    const { stage, view, hook } = standInView()
    // a phone-sized view: the bed's right edge at 740 px is past it, so the right has no room at all
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 700, bottom: 800, width: 700, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    enableEdgeDrag(view, host().options)
    await begin(hook()!, info(30, 80, 50, 100, ['a'], 'touch'))
    try {
      // the part on its way right, by its arrow
      const going = info(40, 80, 60, 100, ['a'], 'touch')
      hook()!.move(going)
      const slid = () => view.setDragZoom.mock.calls.filter((c) => Array.isArray(c[2]) && (c[2] as number[])[0] !== 0)
      await vi.waitFor(() => expect(slid().length).toBeGreaterThan(0), { timeout: 2_000 })
      const [, , shift] = slid()[0]!
      expect((shift as [number, number])[0]).toBeLessThan(0)
      expect((shift as [number, number])[1]).toBe(0)
      expect(q(stage, 'edge-drag')!.dataset['shift']).toMatch(/^-\d+,0$/)
      // the slide leaves the drag to the line: nothing is armed yet
      await frame()
      expect(q(stage, 'edge-drag-right')!.hasAttribute('data-armed')).toBe(false)
    } finally {
      // a failure above must not leave its overlay up for the tests after it
      hook()!.cancel()
    }
    expect(view.setDragZoom).toHaveBeenLastCalledWith(null, expect.any(Number))
  })

  it('a mouse drag never slides the view', async () => {
    const { stage, view, hook } = standInView()
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 700, bottom: 800, width: 700, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    enableEdgeDrag(view, host().options)
    await begin(hook()!)
    hook()!.move(info(40, 80, 60, 100))
    await new Promise((r) => setTimeout(r, 450))
    await frame()
    for (const call of view.setDragZoom.mock.calls) expect(call.length).toBeLessThanOrEqual(2)
    hook()!.cancel()
  })

  it('past three other plates the top opens a list of the rest after a short wait', async () => {
    const { stage, view, hook } = standInView()
    const h = host()
    h.plates.push({ id: 'plate-5', label: 'Plate 5', order: 4 })
    enableEdgeDrag(view, h.options)
    await begin(hook()!)
    expect(q(stage, 'edge-drag-left')!.textContent).toBe('+ Add to Plate 2')
    expect(q(stage, 'edge-drag-right')!.textContent).toBe('+ Add to Plate 3')
    expect(q(stage, 'edge-drag-top')!.textContent).toBe('+ More plates')
    hook()!.move(info(30, 189, 50, 209))
    await frame()
    expect(q(stage, 'edge-drag-live')!.textContent).toBe('Hold to see more plates')
    await new Promise((r) => setTimeout(r, 400))
    await frame()
    const more = q(stage, 'edge-drag-more')!
    expect(more.textContent).toContain('Plate 4')
    expect(more.textContent).toContain('Plate 5')
    expect(q(stage, 'edge-drag-live')!.textContent).toBe('Move onto a plate in the list')
    // released there with no plate picked: nothing moves, and no hint (the line was reached)
    expect(hook()!.end({ ...info(30, 189, 50, 209), onBed: false })).toBe('back')
    expect(h.moves).toEqual([])
    expect(q(stage, 'edge-drag-hint')).toBeNull()
  })
})

describe('labels', () => {
  const labels = {
    addToPlate: (l: string) => `Zu ${l}`,
    addToNewPlate: 'Neue Platte',
    morePlates: 'Weitere Platten',
    hint: 'Weiter ziehen',
    releaseToPlate: (l: string) => `Loslassen: ${l}`,
    releaseToNewPlate: 'Loslassen: neue Platte',
    pickFromList: 'Platte in der Liste wählen',
    holdForMore: 'Halten für weitere Platten',
  }

  it('the defaults are the English strings the app shows', () => {
    expect(DEFAULT_EDGE_DRAG_LABELS.addToPlate('Plate 2')).toBe('+ Add to Plate 2')
    expect(DEFAULT_EDGE_DRAG_LABELS.addToNewPlate).toBe('+ Add to new plate')
    expect(DEFAULT_EDGE_DRAG_LABELS.morePlates).toBe('+ More plates')
    expect(DEFAULT_EDGE_DRAG_LABELS.hint).toBe('Drag past the line to move it')
    expect(DEFAULT_EDGE_DRAG_LABELS.releaseToPlate('Plate 2')).toBe('Release to add to Plate 2')
    expect(DEFAULT_EDGE_DRAG_LABELS.releaseToNewPlate).toBe('Release to add to a new plate')
    expect(DEFAULT_EDGE_DRAG_LABELS.pickFromList).toBe('Move onto a plate in the list')
    expect(DEFAULT_EDGE_DRAG_LABELS.holdForMore).toBe('Hold to see more plates')
    expect(DEFAULT_EDGE_DRAG_LABELS.movedToPlate('Plate 4')).toBe('Moved to Plate 4')
  })

  it('every label can be replaced, on the edges, the live region, the list and the hint', async () => {
    const { stage, view, hook } = standInView()
    const h = host({ labels })
    h.plates.push({ id: 'plate-5', label: 'Plate 5', order: 4 })
    enableEdgeDrag(view, h.options)
    await begin(hook()!)
    expect(q(stage, 'edge-drag-left')!.textContent).toBe('Zu Plate 2')
    expect(q(stage, 'edge-drag-right')!.textContent).toBe('Zu Plate 3')
    expect(q(stage, 'edge-drag-top')!.textContent).toBe('Weitere Platten')
    expect(q(stage, 'edge-drag-bottom')!.textContent).toBe('Neue Platte')
    const live = q(stage, 'edge-drag-live')!
    hook()!.move(info(-29, 30, -9, 50))
    await frame()
    expect(live.textContent).toBe('Loslassen: Plate 2')
    hook()!.move(info(30, -29, 50, -9))
    await frame()
    expect(live.textContent).toBe('Loslassen: neue Platte')
    hook()!.move(info(30, 189, 50, 209))
    await frame()
    expect(live.textContent).toBe('Halten für weitere Platten')
    await new Promise((r) => setTimeout(r, 400))
    await frame()
    expect(live.textContent).toBe('Platte in der Liste wählen')
    hook()!.end({ ...info(30, 189, 50, 209), onBed: false })
    // a short release shows the hint in its own words
    await begin(hook()!)
    expect(hook()!.end({ ...info(183, 30, 203, 50), onBed: false })).toBe('back')
    expect(q(stage, 'edge-drag-hint')!.textContent).toBe('Weiter ziehen')
    expect(h.moves).toEqual([])
    await new Promise((r) => setTimeout(r, 1900))
    expect(overlaysMounted()).toBe(0)
  })

  it('a partial set keeps the English for the rest', async () => {
    const { stage, view, hook } = standInView()
    enableEdgeDrag(view, host({ labels: { addToNewPlate: 'New one' } }).options)
    await begin(hook()!)
    expect(q(stage, 'edge-drag-bottom')!.textContent).toBe('New one')
    expect(q(stage, 'edge-drag-left')!.textContent).toBe('+ Add to Plate 2')
    hook()!.cancel()
  })
})

describe('theme', () => {
  const keys = Object.keys(EDGE_DRAG_PROPERTIES) as (keyof typeof EDGE_DRAG_PROPERTIES)[]

  it('names a custom property for every themable color', () => {
    expect(EDGE_DRAG_PROPERTIES).toMatchObject({
      band: '--sx-edge-band',
      line: '--sx-edge-line',
      commit: '--sx-edge-commit',
      halo: '--sx-edge-halo',
      label: '--sx-edge-label',
      labelArmed: '--sx-edge-label-armed',
      drop: '--sx-edge-drop',
      badge: '--sx-edge-badge',
    })
    for (const k of keys) expect(EDGE_DRAG_PROPERTIES[k]).toMatch(/^--sx-edge-[a-z-]+$/)
  })

  it('the theme option sets each property on the overlay, and with none the overlay sets nothing', async () => {
    const theme = Object.fromEntries(keys.map((k, i) => [k, `rgb(${i}, ${100 + i}, ${200 - i})`]))
    const one = standInView()
    enableEdgeDrag(one.view, host({ theme }).options)
    await begin(one.hook()!)
    const root = q(one.stage, 'edge-drag')!
    for (const k of keys) expect(root.style.getPropertyValue(EDGE_DRAG_PROPERTIES[k]), k).toBe(theme[k])
    one.hook()!.cancel()

    const two = standInView()
    enableEdgeDrag(two.view, host().options)
    await begin(two.hook()!)
    const plain = q(two.stage, 'edge-drag')!
    for (const k of keys) expect(plain.style.getPropertyValue(EDGE_DRAG_PROPERTIES[k]), k).toBe('')
    two.hook()!.cancel()
  })

  it('every rule color reads its property first and falls back to the page tokens', async () => {
    const { view, hook } = standInView()
    enableEdgeDrag(view, host().options)
    await begin(hook()!)
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n')
    for (const k of keys) expect(css, k).toContain(`var(${EDGE_DRAG_PROPERTIES[k]}`)
    // unset, the app's own tokens decide, so the app looks as it did
    expect(css).toContain('var(--sx-edge-band, var(--accent')
    expect(css).toContain('var(--sx-edge-label, var(--fg')
    hook()!.cancel()
  })
})
