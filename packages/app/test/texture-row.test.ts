// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The paint panel's From texture row: a preview first, Apply as one Undo step, Cancel leaves nothing, picked files
// with a missing image only say so, a preview for an object no longer selected never shows or applies, and a preview
// made before the filaments changed is not applied. The engine answer is a fixed one here; texture-open.test.ts and
// app-link-paint-texture.test.ts run the real engine.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileRef, Host, MeshHandle } from '@slicerx/contracts'
import { setGeomProvider } from '../src/geom/client'
import { HostContext } from '../src/host'
import { history, inStep } from '../src/plate/history'
import { commitStroke } from '../src/plate/paint'
import { boxMesh } from '../src/plate/mesh-ops'
import { rememberTexture, type TextureSource } from '../src/plate/texture-paint'
import { identity } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { TextureRow } from '../src/workspaces/prepare/texture-row'

const RGBW = ['#e6141e', '#14c828', '#1428dc', '#f5f5f5']
const entry = (id: string): PlateEntry => ({ id, name: id, handle: { id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'body', slot: 1, triangles: 12 }] } as MeshHandle, parts: [boxMesh(10, 10, 10)], colors: ['#fff'], transform: identity() })
const src: TextureSource = { kind: 'obj', name: 'cube.obj', obj: new Uint8Array(), files: {} }
const reply = { textured: true, parts: [{ slot: 1, paint: { 0: '8', 1: '12' }, painted: 2 }], slots: [{ slot: 1, areaMm2: 900 }, { slot: 2, areaMm2: 500 }, { slot: 3, areaMm2: 500 }, { slot: 4, areaMm2: 500 }], colors: [1, 2, 3, 4], palette: [], leaves: 9, images: [], notes: [] }

let engine = vi.fn(async () => reply as unknown)
const host = (files: Record<string, string> = {}, picked: string[] = []) =>
  ({
    files: {
      open: vi.fn(async () => picked.map((name): FileRef => ({ id: name, name, size: 1 }))),
      read: async (r: FileRef) => new TextEncoder().encode(files[r.name] ?? '').buffer,
    },
  }) as unknown as Host
const mount = (e: PlateEntry | undefined, h = host()) => render(createElement(HostContext.Provider, { value: h }, createElement(TextureRow, { entry: e })))
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

beforeEach(() => {
  set({ plate: [entry('a'), entry('b')], plates: [{ id: 'p', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p', printerSlots: [], fileSlotColors: [], toast: null, slotSetup: Object.fromEntries(RGBW.map((color, i) => [i + 1, { type: 'PLA', brand: '', color }])) })
  history().clear()
  engine = vi.fn(async () => reply as unknown)
  setGeomProvider({ call: engine as never })
  rememberTexture('a', src)
})
afterEach(() => {
  cleanup()
  setGeomProvider(null)
})

describe('From texture in the paint panel', () => {
  it('previews first, then Apply paints as one Undo step with one toast', async () => {
    mount(get().plate[0])
    fireEvent.click(screen.getByTestId('paint-from-texture'))
    await flush()
    expect(screen.getByTestId('paint-texture-preview').textContent).toContain('Paints 4 colors to filaments 1, 2, 3 and 4.')
    expect(get().plate[0]!.paint).toBeUndefined()
    fireEvent.click(screen.getByTestId('paint-texture-apply'))
    expect(get().plate[0]!.paint?.[0]?.color).toEqual({ 0: '8', 1: '12' })
    expect(history().state().undo).toBe(1)
    expect(get().toast?.text).toBe('Painted from texture: 4 colors to filaments 1, 2, 3 and 4.')
    expect(screen.queryByTestId('paint-texture-preview')).toBeNull()
  })

  it('says one color in the singular, and Cancel leaves the object as it was', async () => {
    engine.mockImplementation(async () => ({ ...reply, slots: [{ slot: 2, areaMm2: 2400 }], colors: [2] }))
    mount(get().plate[0])
    fireEvent.click(screen.getByTestId('paint-from-texture'))
    await flush()
    expect(screen.getByTestId('paint-texture-preview').textContent).toContain('Paints 1 color to filament 2.')
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByTestId('paint-texture-preview')).toBeNull()
    expect(get().plate[0]!.paint).toBeUndefined()
    expect(history().state().undo).toBe(0)
  })

  it('offers filament colors from the texture only while no color is set by hand', async () => {
    mount(get().plate[0])
    fireEvent.click(screen.getByTestId('paint-from-texture'))
    await flush()
    expect(screen.queryByTestId('paint-texture-palette')).toBeNull()
    cleanup()
    set({ slotSetup: {}, printerSlots: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] as never })
    engine.mockImplementation(async () => ({ ...reply, palette: RGBW }))
    mount(get().plate[0])
    fireEvent.click(screen.getByTestId('paint-from-texture'))
    await flush()
    fireEvent.click(screen.getByTestId('paint-texture-palette'))
    await flush()
    expect(screen.getByTestId('paint-texture-preview').textContent).toContain('with filament colors picked from the texture')
    expect(engine.mock.calls.at(-1)).toMatchObject([ 'paint.texture', { mode: 'palette' } ])
    fireEvent.click(screen.getByTestId('paint-texture-apply'))
    expect([1, 2, 3, 4].map((i) => get().slotSetup[i]?.color)).toEqual(RGBW)
  })

  it('keeps each filament type when the palette sets the colors, and one Undo takes back colors and paint', async () => {
    const types = ['PETG', 'ABS', 'PLA', 'TPU']
    set({ slotSetup: {}, printerSlots: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] as never, fileSlotColors: ['#111111', '#222222', '#333333', '#444444'], fileSlotTypes: types })
    history().clear()
    engine.mockImplementation(async () => ({ ...reply, palette: RGBW }))
    mount(get().plate[0])
    fireEvent.click(screen.getByTestId('paint-from-texture'))
    await flush()
    fireEvent.click(screen.getByTestId('paint-texture-palette'))
    await flush()
    fireEvent.click(screen.getByTestId('paint-texture-apply'))
    expect([1, 2, 3, 4].map((i) => [get().slotSetup[i]?.type, get().slotSetup[i]?.brand, get().slotSetup[i]?.color])).toEqual(types.map((t, i) => [t, '', RGBW[i]]))
    expect(get().plate[0]!.paint?.[0]?.color).toEqual({ 0: '8', 1: '12' })
    expect(history().state().undo).toBe(1)
    history().undo()
    expect(get().slotSetup).toEqual({})
    expect(get().plate[0]!.paint).toBeUndefined()
    expect(history().state().undo).toBe(0)
  })

  it('asks for the missing image when picked files leave it out, and paints nothing', async () => {
    const h = host({ 'cube.obj': 'mtllib cube.mtl\nv 0 0 0\n', 'cube.mtl': 'newmtl a\nmap_Kd cube.png\n' }, ['cube.obj', 'cube.mtl'])
    mount(get().plate[1], h)
    fireEvent.click(screen.getByTestId('paint-from-texture'))
    await flush()
    expect(screen.getByText('Pick cube.png together with cube.obj.')).toBeTruthy()
    expect(engine).not.toHaveBeenCalled()
    expect(get().plate[1]!.paint).toBeUndefined()
  })

  it('drops a preview that ends after another object was selected', async () => {
    let finish: (v: unknown) => void = () => undefined
    engine.mockImplementation(() => new Promise((r) => (finish = r)))
    rememberTexture('b', src)
    const view = mount(get().plate[0])
    fireEvent.click(screen.getByTestId('paint-from-texture'))
    await flush()
    view.rerender(createElement(HostContext.Provider, { value: host() }, createElement(TextureRow, { entry: get().plate[1] })))
    finish(reply)
    await flush()
    expect(screen.queryByTestId('paint-texture-preview')).toBeNull()
    expect(get().plate.every((e) => !e.paint)).toBe(true)
  })

  it('does not apply a preview made before the object changed', async () => {
    mount(get().plate[0])
    fireEvent.click(screen.getByTestId('paint-from-texture'))
    await flush()
    // a stroke on a triangle the texture leaves unpainted, after the preview
    act(() => inStep({}, () => commitStroke({ objectId: 'a', partIndex: 0, layer: 'color', edits: [{ triangle: 5, after: '4' }] })))
    fireEvent.click(screen.getByTestId('paint-texture-apply'))
    expect(get().plate[0]!.paint?.[0]?.color).toEqual({ 5: '4' })
    expect(history().state().undo).toBe(1)
    expect(screen.getByText('The object changed since this preview. Press From texture again.')).toBeTruthy()
  })

  it('does not apply a preview made before the filaments changed', async () => {
    mount(get().plate[0])
    fireEvent.click(screen.getByTestId('paint-from-texture'))
    await flush()
    act(() => set({ slotSetup: { ...get().slotSetup, 2: { type: 'PLA', brand: '', color: '#000000' } } }))
    fireEvent.click(screen.getByTestId('paint-texture-apply'))
    expect(get().plate[0]!.paint).toBeUndefined()
    expect(screen.getByText('The filaments changed since this preview. Press From texture again.')).toBeTruthy()
  })
})
