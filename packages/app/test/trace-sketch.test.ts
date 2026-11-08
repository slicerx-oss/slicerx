// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Trace image in the sketch tool (cad/trace-sketch.ts, cad/trace-dialog.tsx): the form becomes the engine's
// sketch.trace options, problems are named before anything runs, the preview traces the small image after a pause, a
// click in the color mode picks the color under it, and Add traces the file at the full size and hands the loops over,
// unless the dialog is canceled or closed first.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { SketchLoop } from '@slicerx/cad-history'
import type { SketchTrace, SketchTraceImage, SketchTraceOptions } from '../src/geom/cad'
import { defaultTraceForm, mmToImage, readImageFile, toBase64, traceCounts, traceImage, traceNote, traceOptions, traceProblem } from '../src/cad/trace-sketch'
import { fromLoops } from '../src/cad/sketch-model'
import { mimirTools } from '../src/workspaces/mimir/scripted'
import type { PilotTool } from '@slicerx/pilot'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TraceImageDialog, PREVIEW_DELAY_MS, tracePath, fitIn } = await import('../src/cad/trace-dialog')

// what sketch.trace answers for a 40 mm square with a round hole
const LOOPS: SketchLoop[] = [
  { start: [-20, 20], segments: [{ type: 'line', to: [20, 20] }, { type: 'line', to: [20, -20] }, { type: 'line', to: [-20, -20] }, { type: 'line', to: [-20, 20] }] },
  { type: 'circle', center: [0, 0], diameterMm: 10 },
]
const reply = (over: Partial<SketchTrace> = {}): SketchTrace => ({
  loops: LOOPS,
  counts: { lines: 4, arcs: 0, splines: 0, circles: 1 },
  sizeMm: [40, 40],
  mmPerPx: 0.4,
  imagePx: [100, 100],
  workingPx: [100, 100],
  dropped: { specks: 2, holes: 1 },
  check: {
    ok: true,
    polygons: [{ outer: [[-20, -20], [20, -20], [20, 20], [-20, 20]], holes: [] }],
    areaMm2: 1521,
    loops: [
      { index: 0, role: 'outer', areaMm2: 1600, lengthMm: 160 },
      { index: 1, role: 'hole', areaMm2: 79, lengthMm: 31 },
    ],
    issues: [],
  },
  warnings: [],
  mode: 'dark',
  threshold: 128,
  pxToMm: [0.4, -20, -20],
  ...over,
})

/** A stand-in for the engine that records what it was asked. */
function engine(r: SketchTrace = reply()) {
  const calls: { image: SketchTraceImage; options: SketchTraceOptions }[] = []
  const run = async (image: SketchTraceImage, options: SketchTraceOptions) => {
    calls.push({ image, options })
    return r
  }
  return { calls, run }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('Trace image: the form', () => {
  it('sends the size, the center and the settings that apply to the mode', () => {
    const form = { ...defaultTraceForm([10, 20]), mode: 'dark' as const, threshold: 90, colors: ['#ff0000'] }
    expect(traceOptions(form, 1024)).toEqual({ mode: 'dark', threshold: 90, speckMm2: 0.5, fit: 'curves', cornerAngleDeg: 50, widthMm: 50, center: [10, 20], maxSidePx: 1024 })
    const color = { ...form, mode: 'color' as const, size: 'pixel' as const, value: 0.2, smoothingMm: 0.1 }
    expect(traceOptions(color, 2048)).toEqual({ mode: 'color', colors: ['#ff0000'], colorTolerance: 12, speckMm2: 0.5, smoothingMm: 0.1, fit: 'curves', cornerAngleDeg: 50, mmPerPx: 0.2, center: [10, 20], maxSidePx: 2048 })
    expect(traceOptions({ ...form, size: 'height', value: 30 }, 2048)).toMatchObject({ heightMm: 30 })
  })

  it('names what is wrong before the engine runs', async () => {
    const d = defaultTraceForm([0, 0])
    expect(traceProblem(d)).toBeNull()
    expect(traceProblem({ ...d, mode: 'color' })).toBe('Click the image to pick a color to trace.')
    expect(traceProblem({ ...d, colors: Array.from({ length: 9 }, () => '#000000') })).toBe('Pick at most 8 colors.')
    expect(traceProblem({ ...d, threshold: 300 })).toBe('The threshold must be 0 to 255.')
    expect(traceProblem({ ...d, speckMm2: -1 })).toBe('Remove specks under must be 0 mm² or more.')
    expect(traceProblem({ ...d, smoothingMm: 0 })).toBe('Smoothing must be 0.01 to 10 mm.')
    expect(traceProblem({ ...d, cornerDeg: 180 })).toBe('The corner angle must be 1 to 179°.')
    expect(traceProblem({ ...d, value: 0 })).toBe('The width must be more than 0 mm.')
    expect(traceProblem({ ...d, size: 'pixel', value: 101 })).toBe('The pixel size must be 100 mm or less.')
    expect(traceProblem({ ...d, center: [Number.NaN, 0] })).toBe('The center must be two numbers in mm.')
    const e = engine()
    await expect(traceImage({ base64: '' }, { ...d, value: -1 }, 2048, e.run)).rejects.toThrow('The width must be more than 0 mm.')
    expect(e.calls).toHaveLength(0)
  })

  it('says what came in, what was cleaned away and what to fix', () => {
    expect(traceCounts(reply())).toBe('2 loops (1 hole), 4 lines, 1 circle, 40 x 40 mm')
    expect(traceNote('logo.png', reply())).toEqual({ text: 'Added logo: 2 loops (1 hole), 4 lines, 1 circle, 40 x 40 mm. Removed 2 specks and 1 pinhole.', warn: false })
    const bad = reply({ check: { ...reply().check, ok: false, issues: [{ loop: 0, kind: 'selfCrossing', message: 'Loop 1 crosses itself.' }] as never }, warnings: ['1 short curve stays a little further off than Smoothing'], dropped: { specks: 0, holes: 0 } })
    expect(traceNote('photo.JPG', bad)).toEqual({ text: 'Added photo: 2 loops (1 hole), 4 lines, 1 circle, 40 x 40 mm. 1 problem to fix before it makes a solid. 1 short curve stays a little further off than Smoothing.', warn: true })
  })

  it('maps sketch mm back onto the image, y down', () => {
    expect(mmToImage(reply(), [-20, -20])).toEqual([0, 100])
    expect(mmToImage(reply(), [20, 20])).toEqual([100, 0])
  })

  it('reads only PNG and JPEG files, and encodes them in pieces', async () => {
    expect(await readImageFile(new File([PNG], 'a.png'))).toMatchObject({ name: 'a.png' })
    expect(await readImageFile(new File([new Uint8Array([0xff, 0xd8, 0xff])], 'b.jpg'))).toMatchObject({ name: 'b.jpg' })
    await expect(readImageFile(new File(['<svg/>'], 'c.svg'))).rejects.toThrow('That file is not a PNG or JPEG image.')
    const big = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 251)
    expect(atob(toBase64(big))).toHaveLength(big.length)
    expect(toBase64(PNG)).toBe(btoa(String.fromCharCode(...PNG)))
  })

  it('draws the loops as a path in the preview pixels, and fits the image whole at one scale', () => {
    // the reply's square is the whole 100 px working image; a 50 px preview halves it
    expect(tracePath(reply(), 50)).toBe('M0 50L50 50L50 0L0 0Z')
    expect(fitIn({ width: 600, height: 300 }, 200, 100)).toEqual({ width: 600, height: 300, scale: 3 })
    expect(fitIn({ width: 600, height: 600 }, 200, 100)).toEqual({ width: 600, height: 300, scale: 3 })
    expect(fitIn({ width: 100, height: 600 }, 200, 100)).toEqual({ width: 100, height: 50, scale: 0.5 })
    expect(fitIn({ width: 0, height: 0 }, 200, 100)).toEqual({ width: 200, height: 100, scale: 1 })
  })

  it('gives loops the sketch can hold', () => {
    expect(fromLoops(reply().loops)).toHaveLength(2)
  })

  it("stays out of the assistant tab's tools, where the person traces with the dialog", () => {
    const tool = (name: string) => ({ name }) as PilotTool<never>
    const names = mimirTools([tool('design.trace_image'), tool('design.sketch_svg'), tool('design.sketch')]).map((t) => t.name)
    expect(names).not.toContain('design.trace_image')
    expect(names).toEqual(expect.arrayContaining(['design.sketch_svg', 'design.sketch']))
  })
})

describe('Trace image: the dialog', () => {
  let root: Root | null = null
  let el: HTMLDivElement | null = null
  beforeAll(() => {
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    }
    // jsdom draws nothing; the preview's drawing is checked in the journeys
    HTMLCanvasElement.prototype.getContext = (() => null) as never
  })
  afterEach(() => {
    act(() => root?.unmount())
    el?.remove()
    root = null
  })

  const wait = (ms: number) => act(async () => new Promise<void>((r) => setTimeout(r, ms)))
  // a 4 x 2 image: red on the left half, white on the right
  const decode = async () => ({ width: 4, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]) })

  async function show(run: ReturnType<typeof engine>['run'], added: { name: string; r: SketchTrace }[], closed: { n: number }) {
    el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
    await act(async () =>
      root!.render(createElement(TraceImageDialog, { open: true, onClose: () => void (closed.n += 1), center: [100, 50], onAdd: (name: string, r: SketchTrace) => void added.push({ name, r }), run, decode })),
    )
  }
  async function choose(name: string, bytes: Uint8Array) {
    const input = document.querySelector<HTMLInputElement>('[data-testid="trace-file"]')!
    Object.defineProperty(input, 'files', { value: [new File([bytes as BlobPart], name)], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await wait(PREVIEW_DELAY_MS + 50)
  }
  const add = () => document.querySelector<HTMLButtonElement>('[data-testid="trace-add"]')!
  const count = () => document.querySelector('[data-testid="trace-count"]')!.textContent

  it('previews the small image after a pause, then adds the full file and closes', async () => {
    const e = engine()
    const added: { name: string; r: SketchTrace }[] = []
    const closed = { n: 0 }
    await show(e.run, added, closed)
    // before a file only the stage's hint and the field speak; the line under the stage is empty
    expect(count()).toBe('')
    expect(document.querySelector('.trace-empty')!.textContent).toBe('A logo, drawing or photo with clear edges traces best.')
    expect(add().disabled).toBe(true)
    await choose('logo.png', PNG)
    expect(e.calls).toHaveLength(1)
    expect(e.calls[0]!.image).toMatchObject({ width: 4, height: 2 })
    expect(e.calls[0]!.options).toMatchObject({ mode: 'auto', widthMm: 50, center: [100, 50], maxSidePx: 1024 })
    expect(count()).toBe('2 loops (1 hole), 4 lines, 1 circle, 40 x 40 mm · Threshold 128')
    expect(add().disabled).toBe(false)
    await act(async () => add().click())
    expect(e.calls[1]!.image).toEqual({ base64: toBase64(PNG) })
    expect(e.calls[1]!.options.maxSidePx).toBe(2048)
    expect(added.map((a) => a.name)).toEqual(['logo.png'])
    expect(closed.n).toBe(1)
  })

  it('traces again once after quick changes, and refuses a bad file with a reason', async () => {
    const e = engine()
    await show(e.run, [], { n: 0 })
    await choose('notes.txt', new TextEncoder().encode('hello'))
    expect(document.querySelector('[data-testid="trace-note"]')!.textContent).toContain('That file is not a PNG or JPEG image.')
    expect(e.calls).toHaveLength(0)
    await choose('logo.png', PNG)
    const speck = document.querySelector<HTMLInputElement>('#trace-speck')!
    const type = async (v: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(speck, v)
      await act(async () => speck.dispatchEvent(new Event('input', { bubbles: true })))
    }
    await type('1')
    await type('2')
    await wait(PREVIEW_DELAY_MS + 50)
    expect(e.calls.map((c) => c.options.speckMm2)).toEqual([0.5, 2])
    await type('-1')
    await wait(PREVIEW_DELAY_MS + 50)
    expect(document.querySelector('[data-testid="trace-note"]')!.textContent).toContain('Remove specks under must be 0 mm² or more.')
    expect(add().disabled).toBe(true)
    expect(e.calls).toHaveLength(2)
  })

  it('picks the color clicked in the color mode', async () => {
    const e = engine()
    await show(e.run, [], { n: 0 })
    await choose('logo.png', PNG)
    const mode = document.querySelector<HTMLSelectElement>('#trace-mode select, select#trace-mode')
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const colorOption = radios.find((b) => b.textContent === 'Color')
    if (colorOption) await act(async () => colorOption.click())
    else {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      set.call(mode, 'color')
      await act(async () => mode!.dispatchEvent(new Event('change', { bubbles: true })))
    }
    await wait(PREVIEW_DELAY_MS + 50)
    expect(document.querySelector('[data-testid="trace-note"]')!.textContent).toContain('Click the image to pick a color to trace.')
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="trace-preview"]')!
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) })
    await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 150 })))
    await wait(PREVIEW_DELAY_MS + 50)
    expect(e.calls.at(-1)!.options).toMatchObject({ mode: 'color', colors: ['#ff0000'], colorTolerance: 12 })
  })

  /** A stand-in for the engine whose replies come when the test says. */
  function held() {
    const calls: { image: SketchTraceImage; options: SketchTraceOptions; signal: AbortSignal | undefined; done: (r: SketchTrace) => void; fail: (e: Error) => void }[] = []
    const run = (image: SketchTraceImage, options: SketchTraceOptions, signal?: AbortSignal) =>
      new Promise<SketchTrace>((done, fail) => void calls.push({ image, options, signal, done, fail }))
    return { calls, run }
  }
  const typeInto = async (id: string, v: string) => {
    const input = document.querySelector<HTMLInputElement>(id)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v)
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
  }
  const cancel = () => [...document.querySelectorAll<HTMLButtonElement>('.trace-foot button')].find((b) => b.textContent === 'Cancel')!

  it('previews a pixel size at the size Add makes, by sending the file size with the small pixels', async () => {
    const e = engine()
    el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
    // the browser shrank a 4000 x 2000 file to 4 x 2
    const big = async () => ({ ...(await decode()), fileWidth: 4000, fileHeight: 2000 })
    await act(async () => root!.render(createElement(TraceImageDialog, { open: true, onClose: () => undefined, center: [0, 0], onAdd: () => undefined, run: e.run, decode: big })))
    await choose('logo.png', PNG)
    expect(e.calls[0]!.image).toMatchObject({ width: 4, height: 2, fileWidth: 4000, fileHeight: 2000 })
  })

  it('adds nothing when Cancel is pressed or the dialog closes while Add runs', async () => {
    for (const how of ['cancel', 'close'] as const) {
      const e = held()
      const added: { name: string; r: SketchTrace }[] = []
      const closed = { n: 0 }
      await show(e.run, added, closed)
      await choose('logo.png', PNG)
      await act(async () => e.calls[0]!.done(reply()))
      await act(async () => add().click())
      const adding = e.calls[1]!
      expect(adding.options.maxSidePx).toBe(2048)
      if (how === 'cancel') await act(async () => cancel().click())
      else act(() => root!.unmount())
      expect(adding.signal?.aborted, how).toBe(true)
      await act(async () => adding.done(reply()))
      expect(added, how).toEqual([])
      if (how === 'cancel') {
        expect(closed.n).toBe(1)
        act(() => root!.unmount())
      }
      root = null
      el?.remove()
    }
  })

  it('keeps the dialog open with the reason when Add fails, and drops a preview overtaken by a newer change', async () => {
    const e = held()
    const added: { name: string; r: SketchTrace }[] = []
    const closed = { n: 0 }
    await show(e.run, added, closed)
    await choose('logo.png', PNG)
    // a slow first preview, then a change whose preview answers first
    await typeInto('#trace-speck', '2')
    await wait(PREVIEW_DELAY_MS + 50)
    expect(e.calls).toHaveLength(2)
    expect(e.calls[0]!.signal?.aborted).toBe(true)
    await act(async () => e.calls[1]!.done(reply({ sizeMm: [12, 12] })))
    await act(async () => e.calls[0]!.done(reply({ sizeMm: [99, 99] })))
    expect(count()).toContain('12 x 12 mm')
    await act(async () => add().click())
    await act(async () => e.calls[2]!.fail(new Error('image: more than 2000 loops; raise Remove specks under, or use a simpler image')))
    expect(document.querySelector('[data-testid="trace-note"]')!.textContent).toContain('More than 2000 loops; raise Remove specks under')
    expect(added).toEqual([])
    expect(closed.n).toBe(0)
    expect(add().disabled).toBe(false)
  })

  it('stops saying Tracing once a form problem stops the preview', async () => {
    const e = held()
    await show(e.run, [], { n: 0 })
    await choose('logo.png', PNG)
    expect(count()).toBe('Tracing…')
    await typeInto('#trace-speck', '-1')
    await wait(PREVIEW_DELAY_MS + 50)
    expect(count()).toBe('')
  })

  it('refuses a file over 30 MB before reading it', async () => {
    const f = new File([PNG], 'huge.png')
    Object.defineProperty(f, 'size', { value: 30 * 1024 * 1024 + 1 })
    await expect(readImageFile(f)).rejects.toThrow('The image is larger than 30 MB. Export it smaller first.')
  })
})
