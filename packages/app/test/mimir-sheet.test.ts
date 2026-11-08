// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sheet's drawing: a solid's faces point out of the material, a size shows in the flat view it reads in and in the
// iso view, callouts stay in their cell and clear of each other, and the flat views can share one scale. The scripted
// parts each come with a drawing that places every size but the ones that are not on the part, and a sheet the person
// cancels ends the script with nothing built.
import type { Host, PilotDim, PilotEvent, PilotSheet, PilotSheetSolid } from '@slicerx/contracts'
import { createApprovalBroker, DEFAULT_CONFIG } from '@slicerx/pilot'
import type { LlmMessage } from '@slicerx/pilot'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { drawView, fitScale, readsIn, shapeOfSolids, SHEET_VIEWS, solidFaces, viewsFor, type V3 } from '../src/workspaces/mimir/sheet-draw'
import { backplatePart, boundWall, boxPart, SCRIPTS, standPart } from '../src/workspaces/mimir/scripts'
import { mimirTools, scriptedMimir } from '../src/workspaces/mimir/scripted'
import { setDraft, sheetMode, sheetUi, setShownSheet, typedValues } from '../src/workspaces/mimir/sheet-ui'
import { get, set, type PlateEntry } from '../src/state/store'
import { MimirSheet, sourceHost } from '../src/workspaces/mimir/sheet-view'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { tabPilotOptions } from '../src/workspaces/mimir/session'

const CUBE: PilotSheetSolid = { plane: 'xy', points: [[0, 0], [0, 10], [10, 10], [10, 0]], from: 0, to: 10 }

const dim = (key: string, at: PilotDim['at'], source: PilotDim['source'] = 'guess'): PilotDim => ({ key, label: key, value: 10, unit: 'mm', source, ...(at ? { at } : {}) })

/** The distance from a point to a segment. */
function toSegment(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const [dx, dy] = [b[0]! - a[0]!, b[1]! - a[1]!]
  const t = Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p[0]! - a[0]! - t * dx, p[1]! - a[1]! - t * dy)
}

describe('the sheet drawing', () => {
  it('turns a solid into sides and caps whose normals point out, whichever way its outline runs', () => {
    const faces = solidFaces(CUBE)
    expect(faces).toHaveLength(6)
    for (const f of faces) {
      const c = f.pts.reduce<V3>((s, p) => [s[0] + p[0] / f.pts.length, s[1] + p[1] / f.pts.length, s[2] + p[2] / f.pts.length], [0, 0, 0])
      const out = [c[0] - 5, c[1] - 5, c[2] - 5]
      expect(out[0]! * f.n[0] + out[1]! * f.n[1] + out[2]! * f.n[2]).toBeGreaterThan(0)
    }
    // a hole's sides face into the hole, out of the material, and the caps carry it
    const ring = solidFaces({ ...CUBE, holes: [[[4, 4], [6, 4], [6, 6], [4, 6]]] })
    expect(ring).toHaveLength(10)
    const holeSide = ring.find((f) => f.pts.every((p) => p[0] === 4))!
    expect(holeSide.n[0]).toBeCloseTo(1)
    expect(Math.abs(holeSide.n[1]) + Math.abs(holeSide.n[2])).toBeCloseTo(0)
    expect(ring.at(-1)!.holes).toHaveLength(1)
  })

  it('maps each plane: xz outlines stand up and extrude along Y', () => {
    const faces = solidFaces({ plane: 'xz', points: [[0, 0], [10, 0], [10, 5], [0, 5]], from: -3, to: 3 })
    const ys = faces.flatMap((f) => f.pts.map((p) => p[1]))
    const zs = faces.flatMap((f) => f.pts.map((p) => p[2]))
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([-3, 3])
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([0, 5])
  })

  it('shows a size in the first flat view it reads in, and in the iso view', () => {
    const width = { a: [0, 0, 0] as V3, b: [10, 0, 0] as V3, off: [0, 0, -5] as V3 }
    expect(readsIn(width, 'front')).toBe(true)
    expect(readsIn(width, 'top')).toBe(false)
    expect(readsIn(width, 'side')).toBe(false)
    const lean = { c: [0, 0, 0] as V3, from: [1, 0, 0] as V3, to: [0.34, 0, 0.94] as V3, r: 10 }
    expect(readsIn(lean, 'front')).toBe(true)
    expect(readsIn(lean, 'top')).toBe(false)
    const views = viewsFor([dim('w', width), dim('d', { a: [0, 0, 0], b: [0, 10, 0], off: [-5, 0, 0] }), dim('none', undefined)], ['side', 'front'])
    expect(views.get('w')).toEqual(['front', 'iso'])
    expect(views.get('d')).toEqual(['top', 'iso'])
    expect(views.has('none')).toBe(false)
  })

  it('keeps every callout in its cell and clear of the others, for each scripted part in each view', () => {
    const parts = [
      standPart({ phone_width: 71.6, phone_thickness: 7.8, case_allowance: 1.5, lean: 70, stand_width: 70, base_depth: 80, lip_height: 12 }),
      boxPart({ width: 80, depth: 60, height: 40, wall: 2, lid_fit: 0.2, lip: 3 }),
      backplatePart({ plate_width: 150.4, plate_height: 110.4, thickness: 3, center_hole: 30, screw_hole: 4.5, screw_spacing: 60 }),
    ]
    for (const p of parts) {
      const dims = Object.entries(p.at).map(([k, v]) => dim(k, (v as { at: PilotDim['at'] }).at))
      for (const [w, h] of [[380, 330], [250, 200]] as const) {
        const scale = Math.min(...SHEET_VIEWS.filter((v) => v !== 'iso').map((v) => fitScale(shapeOfSolids(p.part as PilotSheetSolid[]), dims, v, w, h, 34)))
        let callouts = 0
        for (const v of SHEET_VIEWS) {
          const drawn = drawView(shapeOfSolids(p.part as PilotSheetSolid[]), dims, v, w, h, { pad: 34, ...(v === 'iso' ? {} : { scale }) })
          expect(drawn.part.cover.some((c) => c === 1)).toBe(true)
          callouts += drawn.dims.length
          for (const d of drawn.dims) {
            expect(d.badge[0]).toBeGreaterThanOrEqual(10)
            expect(d.badge[0]).toBeLessThanOrEqual(w - 10)
            expect(d.badge[1]).toBeGreaterThanOrEqual(10)
            expect(d.badge[1]).toBeLessThanOrEqual(h - 10)
            // its target is never a guess: the callout touches its own lines, or a leader runs from them to its rim
            const near = Math.min(...[...d.lines, ...(d.arc ?? []).slice(1).map((q, i) => [d.arc![i]!, q] as const)].map(([a, b]) => toSegment(d.badge, a, b)))
            if (d.leader) expect(Math.hypot(d.leader[1][0] - d.badge[0], d.leader[1][1] - d.badge[1])).toBeCloseTo(10, 0)
            else expect(near, `${v} ${d.key}`).toBeLessThanOrEqual(16)
          }
          for (let i = 0; i < drawn.dims.length; i++) {
            for (let j = i + 1; j < drawn.dims.length; j++) {
              const [a, b] = [drawn.dims[i]!.badge, drawn.dims[j]!.badge]
              expect(Math.hypot(a[0] - b[0], a[1] - b[1]), `${v} ${drawn.dims[i]!.key} ${drawn.dims[j]!.key}`).toBeGreaterThanOrEqual(19)
            }
          }
        }
        // each placed size twice: its flat view and the iso view
        expect(callouts).toBe(dims.length * 2)
      }
    }
  })

  it('draws the part at one scale in the flat views when given one', () => {
    const dims = [dim('w', { a: [0, 0, 0], b: [10, 0, 0], off: [0, 0, -5] })]
    const a = drawView(shapeOfSolids([CUBE]), dims, 'front', 300, 300, { scale: 5 })
    const b = drawView(shapeOfSolids([CUBE]), dims, 'top', 300, 300, { scale: 5 })
    // the columns the part covers
    const width = (v: typeof a) => {
      const { W, H, cover } = v.part
      const xs = Array.from({ length: W }, (_, x) => x).filter((x) => Array.from({ length: H }, (_, y) => cover[y * W + x]).some((c) => c === 1))
      return xs.at(-1)! - xs[0]! + 1
    }
    expect(width(a)).toBeCloseTo(50, 0)
    expect(width(b)).toBeCloseTo(50, 0)
  })

  it('names a looked-up size by its site, and only for a web page', () => {
    expect(sourceHost('https://www.example.com/phone-specs')).toBe('example.com')
    expect(sourceHost('javascript:alert(1)')).toBeNull()
    expect(sourceHost(undefined)).toBeNull()
  })
})

describe('the sheet in the view', () => {
  const sheet: PilotSheet = { id: 'sheet_1', title: 'Sizes', views: ['iso'], dims: [dim('w', undefined)] }

  it('shows the drawing while a sheet waits, and the panel after the build only when asked for', () => {
    setShownSheet({ sheet, answer: null, bound: null, replay: false })
    expect(sheetMode(sheetUi.getState())).toBe('confirm')
    const answer = { confirmed: true, values: { w: 12 }, changed: ['w'] }
    setShownSheet({ sheet, answer, bound: { design: 'obj_1', binds: [{ key: 'w', step: 1 }] }, replay: false })
    expect(sheetMode(sheetUi.getState())).toBeNull()
    expect(sheetUi.getState().live).toEqual({ w: 12 })
    sheetUi.setState({ open: true })
    expect(sheetMode(sheetUi.getState())).toBe('drive')
    // a canceled sheet, an unbound one or one from a saved conversation never comes up
    setShownSheet({ sheet: { ...sheet, id: 'sheet_2' }, answer: { confirmed: false, values: {}, changed: [] }, bound: null, replay: false })
    sheetUi.setState({ open: true })
    expect(sheetMode(sheetUi.getState())).toBeNull()
    setShownSheet({ sheet: { ...sheet, id: 'sheet_3' }, answer: null, bound: null, replay: true })
    expect(sheetMode(sheetUi.getState())).toBeNull()
    setShownSheet(null)
  })
})

describe('the sizes panel', () => {
  it('shows a count given in mm with no unit and an angle in degrees, beside a length in mm', () => {
    const row = (key: string, label: string, value: number, unit: PilotDim['unit'] = 'mm'): PilotDim => ({ key, label, value, unit, source: 'guess' })
    const sheet: PilotSheet = { id: 'sheet_units', title: 'Gear sizes', views: ['iso'], dims: [row('teeth', 'Teeth', 20), row('draft_angle', 'Draft', 2), row('lean', 'Lean', 15, 'deg'), row('width', 'Width', 80)] }
    setShownSheet({ sheet, answer: null, bound: null, replay: false })
    try {
      render(createElement(MimirSheet))
      const rows = screen.getAllByTestId('mimir-sheet-row')
      const labels = rows.map((r) => r.querySelector('.mimir-sheet-label')!.textContent)
      expect(labels).toEqual(['Teeth', 'Draft°', 'Lean°', 'Widthmm'])
      expect(within(rows[0]!).getByRole('textbox', { name: 'Teeth' })).toBeTruthy()
      expect(within(rows[1]!).getByRole('textbox', { name: 'Draft, degrees' })).toBeTruthy()
      expect(within(rows[3]!).getByRole('textbox', { name: 'Width, millimeters' })).toBeTruthy()
    } finally {
      cleanup()
      setShownSheet(null)
    }
  })
})

describe('scripted sheets', () => {
  it('give every part a drawing that places each size on the part', async () => {
    for (const message of ['wall mount for my thermostat', 'a box with a lid', 'a stand for my phone']) {
      const p = scriptedMimir(SCRIPTS, mimirTools())
      let shown: PilotSheet | null = null
      for await (const e of p.run('s', message)) {
        if (e.type === 'ask') void p.answer!(e.askId, e.choices[0]!.id)
        if (e.type === 'sheet') {
          shown = e.sheet
          void p.answerSheet!(e.sheet.id, null)
        }
      }
      expect(shown?.part?.length, message).toBeGreaterThan(0)
      // every row has its place, so every row has its callout
      expect(shown!.dims.filter((d) => !d.at).map((d) => d.key), message).toEqual([])
    }
  })

  it('build nothing after a cancel, and say so', async () => {
    const p = scriptedMimir(SCRIPTS, mimirTools())
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'a box with a lid')) {
      events.push(e)
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, null)
    }
    expect(events.some((e) => e.type === 'tool_call' && e.tool.startsWith('design.'))).toBe(false)
    const said = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
    expect(said).toContain('Nothing is built')
  })
})

describe('the scripted sizes sheet of a part already built', () => {
  const box = (lo: [number, number, number], hi: [number, number, number]) => {
    const c = (i: number) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]
    const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
    return { name: 'Box', slot: 1, positions: new Float32Array(Array.from({ length: 8 }, (_, i) => c(i)).flat()), indices: new Uint32Array(quads.flatMap(([a, b, cc, d]) => [a!, b!, cc!, a!, cc!, d!])) }
  }
  const entry = { id: 'obj_box', name: 'Box', parts: [box([0, 0, 0], [80, 60, 30])], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 50, 0, 1], colors: [], handle: {}, history: { steps: [] } } as unknown as PlateEntry

  async function ask(message: string, answer: (sheet: PilotSheet) => Record<string, number> | null = () => null) {
    const p = scriptedMimir(SCRIPTS, mimirTools())
    const events: PilotEvent[] = []
    for await (const e of p.run('s', message)) {
      events.push(e)
      if (e.type === 'ask') void p.answer!(e.askId, e.choices[0]!.id)
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, answer(e.sheet))
    }
    const sheet = (events.find((e) => e.type === 'sheet') as { sheet: PilotSheet } | undefined)?.sheet ?? null
    return { sheet, said: events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('') }
  }

  it('says there is nothing built yet, and shows no sheet, on an empty plate', async () => {
    const before = get().plate
    set({ plate: [] })
    try {
      const out = await ask('Show me the dimension sheet')
      expect(out.sheet).toBeNull()
      expect(out.said).toContain('no part built yet')
    } finally {
      set({ plate: before })
    }
  })

  it('shows the built part\'s overall sizes on it, each placed, and never promises a rebuild it cannot do', async () => {
    const before = get().plate
    set({ plate: [entry] })
    try {
      const out = await ask("Show me the dimension sheet for the box's main sizes", () => null)
      expect(out.sheet).toMatchObject({ design: 'obj_box' })
      expect(out.sheet!.dims.map((d) => [d.key, d.value])).toEqual([['length', 80], ['depth', 60], ['height', 30]])
      expect(out.sheet!.dims.every((d) => d.at)).toBe(true)
      expect(out.said).not.toContain('rebuild it to match')
      const changed = await ask('Show me the main sizes', (sh) => ({ ...Object.fromEntries(sh.dims.map((d) => [d.key, d.value])), length: 100 }))
      expect(changed.said).toContain('cannot rebuild it to new sizes here')
      const same = await ask('Show me the main sizes', (sh) => Object.fromEntries(sh.dims.map((d) => [d.key, d.value])))
      expect(same.said).toContain('Those are the sizes it has now.')
    } finally {
      set({ plate: before })
    }
  })

  it('shows the sizes when the message names the part as a design or a print, and builds when it asks for one', () => {
    const route = (m: string) => SCRIPTS.find((s) => s.match.test(m))?.id
    // "design" and "print" as nouns: the built part's sizes
    for (const m of [
      'Show the main sizes of my box design',
      'The dimension sheet for this design',
      'Main sizes of the print, please',
      'Show me the size sheet for the design',
      'The main sizes of the print',
      'What are the main sizes of my phone stand design?',
      // a noun with a clause after it: the part already printed or designed
      'Show me the size sheet for the box design that I printed',
      'Show the main sizes of the print that failed',
      'Main sizes of the print my brother made',
      'main sizes of the print my printer made',
      'The size sheet for the print, please',
      'Show main sizes of my last print, a lid',
      'show the size sheet of the print: the lid',
      'the size sheet of this print, the lid',
    ])
      expect(route(m), m).toBe('sizes')
    // "design" and "print" asking for a part, at the start of a clause or before a determiner: a build
    const builds: [string, string][] = [
      ['Make a box with a lid and show me the main sizes first', 'box'],
      ['Design a box and show me the size sheet', 'box'],
      ['Build a phone stand, main sizes first', 'stand'],
      ['Design the lid for my box and show me its size sheet', 'box'],
      ['design my stand, main sizes 80 x 60', 'stand'],
      ['Design the box and show its main sizes first', 'box'],
      ['Design another stand with a size sheet', 'stand'],
      ['Design my phone stand and show the main sizes', 'stand'],
      ['Print the stand, show main sizes first', 'stand'],
      ['Please design a lid, main sizes first', 'box'],
      ['Show me the main sizes, then design the lid', 'box'],
      ['Can you design me a box? Size sheet first', 'box'],
    ]
    for (const [m, id] of builds) expect(route(m), m).toBe(id)
    // parts no script here builds: never the sizes of a part already built
    for (const m of ['print the bracket with its size sheet first', 'Design two lids, main sizes first']) expect(route(m), m).not.toBe('sizes')
  })

  it('shows the wall of the sheet tied to this design only, never another design\'s', () => {
    const sheet = (wall: number, k: number): LlmMessage[] => [
      { role: 'assistant', content: '', toolCalls: [{ id: `s${k}`, name: 'pilot.sheet', arguments: '{}' }] },
      { role: 'tool', callId: `s${k}`, content: JSON.stringify({ ok: true, result: { confirmed: true, values: { wall }, changed: [] } }) },
    ]
    const bind = (design: string, k: number): LlmMessage[] => [
      { role: 'assistant', content: '', toolCalls: [{ id: `b${k}`, name: 'pilot.sheet_bind', arguments: JSON.stringify({ design, binds: [{ key: 'wall', step: 1 }] }) }] },
      { role: 'tool', callId: `b${k}`, content: JSON.stringify({ ok: true, result: { bound: 1 } }) },
    ]
    const chat = [...sheet(2, 1), ...bind('obj_box', 1), ...sheet(3.5, 2), ...bind('obj_lid', 2)]
    expect(boundWall(chat, 'obj_box')).toBe(2)
    expect(boundWall(chat, 'obj_lid')).toBe(3.5)
    expect(boundWall(chat, 'obj_other')).toBeUndefined()
  })

  it('builds when the message asks to make a part and also mentions its main sizes', async () => {
    const out = await ask('Make a box with a lid and show me the main sizes first')
    expect(out.sheet?.design).toBeUndefined()
    expect(out.sheet?.part?.length).toBeGreaterThan(0)
  })
})

describe('setting a waiting sheet aside with words', () => {
  it('takes the sizes typed on it along, and nothing when none were typed', () => {
    const sheet = { id: 'sheet_t', title: 'Box', views: ['iso' as const], dims: [{ key: 'width', label: 'Width', value: 80, unit: 'mm' as const, source: 'guess' as const }, { key: 'depth', label: 'Depth', value: 60, unit: 'mm' as const, source: 'guess' as const }] }
    setShownSheet({ sheet, answer: null, bound: null, replay: false })
    expect(typedValues(sheetUi.getState())).toBeNull()
    setDraft('width', 90)
    expect(typedValues(sheetUi.getState())).toEqual({ width: 90, depth: 60 })
    // typed back to what it was: nothing changed
    setDraft('width', 80)
    expect(typedValues(sheetUi.getState())).toBeNull()
    setShownSheet(null)
  })

  it('sends the typed sizes only to the sheet they were typed on, and a new sheet starts with none', () => {
    const dims = [{ key: 'width', label: 'Width', value: 80, unit: 'mm' as const, source: 'guess' as const }]
    setShownSheet({ sheet: { id: 'sheet_a', title: 'Box', views: ['iso'], dims }, answer: null, bound: null, replay: false })
    setDraft('width', 90)
    expect(typedValues(sheetUi.getState(), 'sheet_a')).toEqual({ width: 90 })
    // the view has moved on to another sheet: the first sheet's draft is not this one's
    expect(typedValues(sheetUi.getState(), 'sheet_b')).toBeNull()
    setShownSheet({ sheet: { id: 'sheet_b', title: 'Box', views: ['iso'], dims }, answer: null, bound: null, replay: false })
    expect(sheetUi.getState().draft).toEqual({})
    expect(typedValues(sheetUi.getState(), 'sheet_b')).toBeNull()
    setShownSheet(null)
  })
})

// The tab tells pilot.sheet which built designs it can draw: one on the plate with a part that has geometry.
describe('the tab\'s built designs for a sheet', () => {
  it('names a design on the plate with geometry, never one with only empty parts or one not there', async () => {
    const host = { kind: 'web', slicer: { loadParts: async () => { throw new Error('no parts') } }, printers: { list: async () => [], plugins: async () => [] }, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
    const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }
    const known = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: [] }).sheetDesign!
    const before = get().plate
    const part = (n: number) => ({ name: 'P', slot: 1, positions: new Float32Array(3 * n), indices: new Uint32Array(n) })
    const at = { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], colors: [], handle: {} }
    set({ plate: [{ id: 'obj_full', name: 'Full', parts: [part(0), part(3)], ...at }, { id: 'obj_empty', name: 'Empty', parts: [part(0), part(0)], ...at }] as unknown as PlateEntry[] })
    try {
      expect(known('obj_full')).toBe(true)
      expect(known('obj_empty')).toBe(false)
      expect(known('obj_gone')).toBe(false)
    } finally {
      set({ plate: before })
    }
  })
})
