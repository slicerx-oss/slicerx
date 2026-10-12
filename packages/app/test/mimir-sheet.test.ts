// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sheet's drawing: a solid's faces point out of the material, a size shows in the flat view it reads in and in the
// iso view, callouts stay in their cell and clear of each other, and the flat views can share one scale. The scripted
// parts each come with a drawing that places every size but the ones that are not on the part, and a sheet the person
// cancels ends the script with nothing built.
import type { PilotDim, PilotEvent, PilotSheet, PilotSheetSolid } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { drawView, fitScale, readsIn, SHEET_VIEWS, solidFaces, viewsFor, type V3 } from '../src/workspaces/mimir/sheet-draw'
import { backplatePart, boxPart, SCRIPTS, standPart } from '../src/workspaces/mimir/scripts'
import { mimirTools, scriptedMimir } from '../src/workspaces/mimir/scripted'
import { sheetMode, sheetUi, setShownSheet } from '../src/workspaces/mimir/sheet-ui'
import { sourceHost } from '../src/workspaces/mimir/sheet-view'

const CUBE: PilotSheetSolid = { plane: 'xy', points: [[0, 0], [0, 10], [10, 10], [10, 0]], from: 0, to: 10 }

const dim = (key: string, at: PilotDim['at'], source: PilotDim['source'] = 'guess'): PilotDim => ({ key, label: key, value: 10, unit: 'mm', source, ...(at ? { at } : {}) })

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
        const scale = Math.min(...SHEET_VIEWS.filter((v) => v !== 'iso').map((v) => fitScale(p.part as PilotSheetSolid[], dims, v, w, h, 34)))
        let callouts = 0
        for (const v of SHEET_VIEWS) {
          const drawn = drawView(p.part as PilotSheetSolid[], dims, v, w, h, { pad: 34, ...(v === 'iso' ? {} : { scale }) })
          expect(drawn.faces.length).toBeGreaterThan(0)
          callouts += drawn.dims.length
          for (const d of drawn.dims) {
            expect(d.badge[0]).toBeGreaterThanOrEqual(10)
            expect(d.badge[0]).toBeLessThanOrEqual(w - 10)
            expect(d.badge[1]).toBeGreaterThanOrEqual(10)
            expect(d.badge[1]).toBeLessThanOrEqual(h - 10)
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
    const a = drawView([CUBE], dims, 'front', 300, 300, { scale: 5 })
    const b = drawView([CUBE], dims, 'top', 300, 300, { scale: 5 })
    const width = (v: typeof a) => {
      const xs = v.faces.flatMap((f) => f.points.split(' ').map((p) => Number(p.split(',')[0])))
      return Math.max(...xs) - Math.min(...xs)
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

describe('scripted sheets', () => {
  it('give every part a drawing that places each size on the part', async () => {
    for (const [message, unplaced] of [['wall mount for my thermostat', []], ['a box with a lid', ['lid_fit']], ['a stand for my phone', ['phone_width']]] as const) {
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
      expect(shown!.dims.filter((d) => !d.at).map((d) => d.key)).toEqual(unplaced)
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
