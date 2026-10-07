// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Host, ListingColors, MeshHandle } from '@slicerx/contracts'
import { createStore } from '@slicerx/store'
import { encodeTree } from '../../ui/viewport/src/paint'
import { deriveColors, normalizeHex, paintStates, type ColorSource } from '../src/export/listing-colors'
import { COVER_COLORS } from '../src/export/cover'
import { writeProject } from '../src/export/threemf'
import { coverInColors, fileModel } from '../src/export/upload-source'
import { compose } from '../src/plate/transform'
import type { PlateEntry } from '../src/state/store'
import { HostContext } from '../src/host'
import { boxMesh } from '../src/plate/mesh-ops'
import { ColorDots, ColorFacts, colorSentence, colorSummary } from '../src/features/store/colors'
import { addColor, draftOf, moveColor, removeColor, savedColors, setPartAms, slotColors, updateColor } from '../src/features/store/colors-edit'
import { openUpload, resetSheets } from '../src/features/store/sheets'
import { submitUpload, UploadHost } from '../src/features/store/upload'

afterEach(() => {
  cleanup()
  resetSheets()
})

const part = (name: string, slot: number) => ({ name, slot })
const PALETTE = ['#1C1C1EFF', '#F2F0EB', '#D4AF37', '#C0392B', '#2E6FD8', '#3FAE5A', '#F39C12', '#8E8E93']

describe('reading colors from a file', () => {
  it('reads painted filament states, leaving out the part own filament', () => {
    const text = encodeTree({ splits: 3, special: 0, kids: [{ state: 0 }, { state: 2 }, { state: 5 }, { splits: 1, special: 1, kids: [{ state: 2 }, { state: 0 }] }] })!
    expect(paintStates(text)).toEqual([2, 5])
    expect(paintStates('8')).toEqual([2])
    expect(paintStates('zz')).toEqual([])
  })

  it('normalizes file colors', () => {
    expect(normalizeHex('#D4AF37FF')).toBe('#d4af37')
    expect(normalizeHex('d4af37')).toBe('#d4af37')
    expect(normalizeHex('gold', 2)).toBe(COVER_COLORS[1])
  })

  it('keeps 8 colors apart from the 2 parts that need the AMS', () => {
    const objects: ColorSource[] = [
      { name: 'Body', parts: [part('a', 1), part('b', 2)] },
      { name: 'Face', parts: [part('face', 3)], paint: { 0: { color: { 0: encodeTree({ state: 4 })!, 3: encodeTree({ state: 5 })! } } } },
      { name: 'Hat', parts: [part('hat', 6)] },
      { name: 'Boot', parts: [part('boot', 7)] },
      { name: 'Base', parts: [part('base', 8)] },
      { name: 'Base', parts: [part('base', 8)] },
      { name: 'Copy', parts: [part('x', 1)], instanceOf: 'o1' },
      { name: 'Off', parts: [part('x', 9)], printable: false },
    ]
    const d = deriveColors(objects, PALETTE)!
    expect(d.colors.colors.map((c) => c.hex)).toEqual(['#1c1c1e', '#f2f0eb', '#d4af37', '#c0392b', '#2e6fd8', '#3fae5a', '#f39c12', '#8e8e93'])
    expect(d.slots).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(d.colors.parts.map((p) => [p.name, p.colors, p.ams])).toEqual([
      ['Body', [0, 1], true],
      ['Face', [2, 3, 4], true],
      ['Hat', [5], false],
      ['Boot', [6], false],
      ['Base', [7], false],
    ])
    expect(colorSentence(d.colors)).toBe('8 colors, 2 parts multi-color (AMS)')
  })

  it('follows a part override and gives nothing for an empty plate', () => {
    const d = deriveColors([{ name: 'Cube', parts: [part('cube', 1)], slotOverrides: { cube: 3 } }], PALETTE)!
    expect(d.slots).toEqual([3])
    expect(colorSummary(d.colors)).toEqual({ colors: 'Single color', ams: null, perPart: false })
    expect(deriveColors([], PALETTE)).toBeNull()
  })
})

/** A plate of five pieces in eight colors: Body is two parts, Face is painted in three colors, the rest are one color each. */
function eightColorProject(): Uint8Array {
  const cube = (name: string, slot: number) => ({ ...boxMesh(20, 20, 20), name, slot })
  const entry = (id: string, name: string, x: number, parts: ReturnType<typeof cube>[], paint?: PlateEntry['paint']): PlateEntry => ({
    id,
    name,
    handle: { id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] } as MeshHandle,
    parts,
    colors: PALETTE,
    transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    ...(paint ? { paint } : {}),
  })
  const objects = [
    entry('a', 'Body', 30, [cube('shell', 1), { ...cube('band', 2), positions: boxMesh(22, 22, 4).positions }]),
    entry('b', 'Face', 70, [cube('face', 3)], { 0: { color: { 0: encodeTree({ state: 4 })!, 5: encodeTree({ state: 5 })! } } }),
    entry('c', 'Hat', 110, [cube('hat', 6)]),
    entry('d', 'Boot', 150, [cube('boot', 7)]),
    entry('e', 'Base', 190, [cube('base', 8)]),
  ]
  return writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects, settings: { sequence: 'by-layer' } }], bed: { widthMm: 256, depthMm: 256 }, settings: { filament_colour: PALETTE.map((c) => c.slice(0, 7)) } })
}

describe('a 3MF on upload', () => {
  it('reads 8 colors with 2 parts multi-color from a written project', async () => {
    const bytes = eightColorProject()
    const out = process.env['SX_COLORS_SAMPLE']
    if (out) (await import('node:fs')).writeFileSync(out, bytes)
    const m = (await fileModel('figure.3mf', bytes))!
    expect(m.colors?.slots).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(colorSentence(m.colors!.colors)).toBe('8 colors, 2 parts multi-color (AMS)')
    expect(m.colors!.colors.parts.filter((p) => p.ams).map((p) => p.name)).toEqual(['Body', 'Face'])
    expect(m.meshes.map((x) => x.slot)).toEqual([1, 2, 3, 6, 7, 8])
    expect(await fileModel('cube.stl', new Uint8Array(84))).toBeNull()
  })
})

describe('the drawn cover', () => {
  it('takes the creator colors by file slot', () => {
    const box = boxMesh(20, 20, 20)
    const model = { colors: null, meshes: [{ positions: box.positions, indices: box.indices, color: '#ff0000', slot: 2 }] }
    // Red minus blue over the whole picture: the part's fill moves it, the drawing's ground and ink do not change.
    const tint = (img: { rgba: Uint8ClampedArray | Uint8Array }) => {
      let t = 0
      for (let i = 0; i < img.rgba.length; i += 4) t += (img.rgba[i] ?? 0) - (img.rgba[i + 2] ?? 0)
      return t
    }
    const red = tint(coverInColors(model, {})!)
    const blue = tint(coverInColors(model, { 2: '#0000ff' })!)
    expect(red).toBeGreaterThan(blue)
    expect(coverInColors({ colors: null, meshes: [] }, {})).toBeNull()
  })
})

describe('the summary line', () => {
  const c = (n: number, parts: ListingColors['parts']): ListingColors => ({ colors: Array.from({ length: n }, () => ({ hex: '#000000' })), parts })
  it('says how many colors and how many parts need the AMS', () => {
    expect(colorSentence(c(1, []))).toBe('Single color')
    expect(colorSentence(c(3, [{ name: 'A', colors: [0], ams: false }, { name: 'B', colors: [1], ams: false }]))).toBe('3 colors, one color per part')
    expect(colorSentence(c(2, [{ name: 'A', colors: [0, 1], ams: true }]))).toBe('2 colors, 1 part multi-color (AMS)')
    expect(colorSentence(c(4, []))).toBe('4 colors')
  })
})

describe('editing colors', () => {
  const base = (): ListingColors => ({
    colors: [{ hex: '#111111' }, { hex: '#222222' }, { hex: '#333333' }],
    parts: [
      { name: 'Body', colors: [0, 1], ams: true },
      { name: 'Lid', colors: [2], ams: false },
    ],
  })

  it('moves part colors with a reordered color, and the cover follows the slot', () => {
    const d = moveColor(draftOf(base(), [1, 2, 3]), 2, 0)
    expect(d.colors.colors.map((c) => c.hex)).toEqual(['#333333', '#111111', '#222222'])
    expect(d.colors.parts).toEqual([
      { name: 'Body', colors: [1, 2], ams: true },
      { name: 'Lid', colors: [0], ams: false },
    ])
    expect(slotColors(updateColor(d, 0, { hex: '#D4AF37' }))).toEqual({ 1: '#111111', 2: '#222222', 3: '#d4af37' })
  })

  it('drops a removed color from its parts, and a part left with one color off the AMS', () => {
    const d = removeColor(draftOf(base(), [1, 2, 3]), 1)
    expect(d.colors.parts).toEqual([
      { name: 'Body', colors: [0], ams: false },
      { name: 'Lid', colors: [1], ams: false },
    ])
    expect(removeColor(d, 1).colors.parts.map((p) => p.name)).toEqual(['Body'])
  })

  it('adds, renames and marks parts, and saves trimmed names', () => {
    let d = addColor(draftOf(base()), '#abcdef')
    d = updateColor(d, 3, { name: '  Silk   gold ' })
    d = setPartAms(d, 1, true)
    expect(savedColors(d)).toEqual({
      colors: [{ hex: '#111111' }, { hex: '#222222' }, { hex: '#333333' }, { hex: '#abcdef', name: 'Silk gold' }],
      parts: [
        { name: 'Body', colors: [0, 1], ams: true },
        { name: 'Lid', colors: [2], ams: true },
      ],
    })
    expect(slotColors(d)).toEqual({})
    expect(savedColors(draftOf(null))).toBeNull()
  })
})

describe('showing colors', () => {
  const eight: ListingColors = {
    colors: ['#1c1c1e', '#f2f0eb', '#d4af37', '#c0392b', '#2e6fd8', '#3fae5a', '#f39c12', '#8e8e93'].map((hex, i) => (i === 2 ? { hex, name: 'Silk gold' } : { hex })),
    parts: [
      { name: 'Body', colors: [0, 1], ams: true },
      { name: 'Face', colors: [2, 3, 4], ams: true },
      { name: 'Hat', colors: [5], ams: false },
    ],
  }

  it('shows five swatches on a card and counts the rest', () => {
    render(createElement(ColorDots, { colors: eight, size: 'sm', max: 5, focusable: false }))
    const list = screen.getByRole('list', { name: '8 colors, 2 parts multi-color (AMS)' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(6)
    expect(within(list).getByText('+3')).toBeTruthy()
  })

  it('names each swatch, marks the AMS ones and gives them focus for the tip', () => {
    render(createElement(ColorFacts, { colors: eight }))
    const gold = screen.getByLabelText('Silk gold, through the AMS')
    expect(gold.getAttribute('tabindex')).toBe('0')
    expect(gold.hasAttribute('data-ams')).toBe(true)
    expect(gold.getAttribute('data-tip-body')).toBe('#d4af37. Through the AMS for Face.')
    expect(screen.getByLabelText('#3fae5a').hasAttribute('data-ams')).toBe(false)
    expect(screen.getByText('8 colors')).toBeTruthy()
    expect(screen.getByText('2 parts multi-color (AMS)')).toBeTruthy()
  })
})

describe('colors in the Vault', () => {
  const zip = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array<number>(64).fill(7)])
  const two: ListingColors = { colors: [{ hex: '#d4af37', name: 'Silk gold' }, { hex: '#1c1c1e' }], parts: [{ name: 'Body', colors: [0, 1], ams: true }] }

  it('stores the colors with the upload', async () => {
    const store = createStore({ offline: true, signedInAs: 'marrow' })
    const r = await submitUpload(store, { title: 'Two tone', description: '', tags: '', license: 'cc0', colors: two }, { name: 't.3mf', bytes: zip(), format: '3mf', vaultCreators: [] }, null, false)
    expect(r.ok).toBe(true)
    const mine = (await store.myListings()).find((l) => l.title === 'Two tone')
    expect(mine?.currentVersion?.colors).toEqual(two)
  })

  it('refuses colors the database would refuse', async () => {
    const store = createStore({ offline: true, signedInAs: 'marrow' })
    const r = await submitUpload(store, { title: 'Bad colors', description: '', tags: '', license: 'cc0', colors: { colors: [{ hex: 'gold' }], parts: [] } }, { name: 'b.3mf', bytes: zip(), format: '3mf', vaultCreators: [] }, null, false)
    expect(r.ok).toBe(false)
  })

  it('edits the colors of an upload from Your uploads', async () => {
    const store = createStore({ offline: true, signedInAs: 'marrow' })
    await submitUpload(store, { title: 'Recolor me', description: '', tags: '', license: 'cc0', colors: two }, { name: 'r.3mf', bytes: zip(), format: '3mf', vaultCreators: [] }, null, false)
    const host = { kind: 'web', capabilities: { secureStorage: false }, store } as unknown as Host
    render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(HostContext.Provider, { value: host }, createElement(UploadHost))))
    act(() => openUpload('list'))
    fireEvent.click(await screen.findByRole('button', { name: 'Colors of Recolor me' }))
    fireEvent.change(screen.getByLabelText('Color 2 name'), { target: { value: 'Matte black' } })
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: 'Save colors' }))
    await waitFor(async () => {
      const v = (await store.myListings()).find((l) => l.title === 'Recolor me')?.currentVersion
      expect(v?.colors).toEqual({ colors: [{ hex: '#d4af37', name: 'Silk gold' }, { hex: '#1c1c1e', name: 'Matte black' }], parts: [{ name: 'Body', colors: [0, 1], ams: false }] })
    })
  })
})
