// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint from a texture: an OBJ opened with its MTL and PNG is painted once the open is done, in one undo step, with a
// toast that says how many colors went to which filaments; the paint saves in a 3MF and reads back the same. Runs
// the real geometry engine (packages/geom/wasm/pkg); skips without one, except on CI.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FileRef, Host, MeshHandle, MeshPart } from '@slicerx/contracts'
import { setGeomProvider } from '../src/geom/client'
import { history } from '../src/plate/history'
import { listSlots, modelHasTextures, objCompanions, paintedText, threemfMayHaveTextures } from '../src/plate/texture-paint'
import { withoutMtllib } from '../src/plate/texture-open'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { allPlates } from '../src/plate/plates'
import { addFileRefs } from '../src/state/open-models'
import { appStore, get, set } from '../src/state/store'
import { liveEngine, wasmGeom } from './geom-engine'

const dir = join(__dirname, '..', '..', 'geom', 'tests', 'fixtures', 'texture')
const file = (name: string) => readFileSync(join(dir, name))

/** Typed arrays as plain arrays, as the app's worker sends them to the engine in its own raw form. */
function plain(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, plain(e)]))
  return v
}

describe('texture paint words and file checks', () => {
  it('lists filaments the way the toast says them', () => {
    expect(listSlots([2])).toBe('2')
    expect(listSlots([1, 3])).toBe('1 and 3')
    expect(listSlots([1, 2, 3, 5])).toBe('1, 2, 3 and 5')
    expect(paintedText([1, 2, 3, 5])).toBe('Painted from texture: 4 colors to filaments 1, 2, 3 and 5')
    expect(paintedText([2])).toBe('Painted from texture: 1 color to filament 2')
  })

  it('finds the MTL and images an OBJ needs, and says which are missing', () => {
    const obj = new TextEncoder().encode('mtllib textured-cube.mtl\nv 0 0 0\n')
    expect(objCompanions(obj, { 'textured-cube.mtl': file('textured-cube.mtl') })).toEqual({ mtl: ['textured-cube.mtl'], images: ['quadrants.png'], missing: ['quadrants.png'] })
    const mtl = new TextEncoder().encode('newmtl a\nmap_Kd -clamp on -s 1 1 1 my tex.png\n')
    expect(objCompanions(obj, { 'textured-cube.mtl': mtl, 'my tex.png': new Uint8Array(1) }).missing).toEqual([])
    expect(objCompanions(obj, {}).missing).toEqual(['textured-cube.mtl'])
  })

  it("comments out the OBJ's mtllib lines for the import, and nothing else", () => {
    const text = 'mtllib a.mtl\nv 0 0 0\n  mtllib b.mtl\r\nmtllib c.mtl\n# no mtllib here\n'
    const out = new TextDecoder().decode(withoutMtllib(new TextEncoder().encode(text).buffer))
    expect(out).toBe('#tllib a.mtl\nv 0 0 0\n  #tllib b.mtl\r\n#tllib c.mtl\n# no mtllib here\n')
  })

  it('tells textures in a 3MF from thumbnails, by names first and then by the model XML', () => {
    expect(threemfMayHaveTextures(['3D/3dmodel.model', '3D/Texture/quadrants.png'])).toBe(true)
    expect(threemfMayHaveTextures(['3D/3dmodel.model', 'Metadata/plate_1.png', 'Metadata/thumbnail.png', 'Thumbnails/t.png'])).toBe(false)
    const enc = new TextEncoder()
    expect(modelHasTextures(enc.encode('<model><resources><m:texture2dgroup id="2" texid="1">'))).toBe(true)
    expect(modelHasTextures(enc.encode('<model><resources><object id="1">'))).toBe(false)
  })
})

describe.skipIf(!liveEngine)('a textured model opened', () => {
  const slicer = {
    loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), bboxMm: [20, 20, 20], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })) }),
    release: () => undefined,
  }
  const bytes = new Map<string, Uint8Array>()
  const host = { slicer, files: { read: async (r: FileRef) => bytes.get(r.name)!.slice().buffer } } as unknown as Host
  const ref = (name: string): FileRef => {
    bytes.set(name, new Uint8Array(file(name)))
    return { id: name, name, size: bytes.get(name)!.length }
  }

  beforeAll(async () => {
    const wasm = await wasmGeom()
    setGeomProvider({ call: (op, request) => wasm.call(op, plain(request)) })
  })
  afterAll(() => setGeomProvider(null))
  beforeEach(() => {
    // four filaments: red, green, blue and white, as the quadrants
    set({ plate: [], printerSlots: [], slotSetup: { 1: { type: 'PLA', brand: '', color: '#e6141e' }, 2: { type: 'PLA', brand: '', color: '#14c828' }, 3: { type: 'PLA', brand: '', color: '#1428dc' }, 4: { type: 'PLA', brand: '', color: '#f5f5f5' } }, toast: null })
  })

  it('paints each quarter in its filament, says so, and one Undo takes the paint off', async () => {
    // the shared history, which the toast's Undo uses
    history()
    {
      const toasts: string[] = []
      const off = appStore.subscribe((s, p) => {
        if (s.toast && s.toast !== p.toast) toasts.push(s.toast.text)
      })
      await addFileRefs(host, [ref('textured-cube.obj'), ref('textured-cube.mtl'), ref('quadrants.png')])
      off()
      // the import is not told the MTL is missing: the texture paint has it
      expect(toasts).toEqual(['Painted from texture: 4 colors to filaments 1, 2, 3 and 4.'])
      const e = get().plate[0]!
      expect(e).toBeDefined()
      expect(get().toast?.text).toBe('Painted from texture: 4 colors to filaments 1, 2, 3 and 4.')
      // red covers the most, so the part prints red and the other three are paint
      expect(e.slotOverrides?.[e.handle.parts[0]!.name] ?? e.parts[0]!.slot).toBe(1)
      const texts = e.paint?.[0]?.color ?? {}
      expect(Object.keys(texts).length).toBeGreaterThan(0)
      const back = (await (await wasmGeom()).call<{ states: { state: number; areaMm2: number }[] }>('paint.regions', plain({ mesh: { positions: e.parts[0]!.positions, indices: e.parts[0]!.indices }, paint: texts }))).states
      expect(back.map((s) => s.state)).toEqual([2, 3, 4])
      for (const s of back) expect(Math.abs(s.areaMm2 - 500)).toBeLessThan(10)
      // the toast's Undo is one step: the model stays, the paint goes
      get().toast!.action!.run()
      expect(get().plate[0]!.paint).toBeUndefined()
      expect(get().plate).toHaveLength(1)
    }
  })

  it('saves the texture paint in a 3MF and reads it back the same, with no texture needed', async () => {
    await addFileRefs(host, [ref('textured-cube.obj'), ref('textured-cube.mtl'), ref('quadrants.png')])
    const e = get().plate[0]!
    const texts = e.paint?.[0]?.color ?? {}
    expect(Object.keys(texts).length).toBeGreaterThan(0)
    const bed = { widthMm: 256, depthMm: 256 }
    readProjectsWithGeom(false)
    try {
      const back = (await readProject(writeProject({ plates: allPlates(get()), bed }), bed)).plates[0]!.objects[0]!
      expect(back.paint?.[0]?.color).toEqual(texts)
    } finally {
      readProjectsWithGeom(true)
    }
  })

  it('paints filaments above 16, and the paint saves and reads back the same', async () => {
    // 20 filaments: 1 to 16 gray, the quadrants' colors on 17 to 20, so filament 18 is written as 0FC
    const gray = { type: 'PLA', brand: '', color: '#808080' }
    const quads = ['#e6141e', '#14c828', '#1428dc', '#f5f5f5'].map((color) => ({ type: 'PLA', brand: '', color }))
    set({ slotSetup: Object.fromEntries([...Array.from({ length: 16 }, () => gray), ...quads].map((v, i) => [i + 1, v])) })
    await addFileRefs(host, [ref('textured-cube.obj'), ref('textured-cube.mtl'), ref('quadrants.png')])
    expect(get().toast?.text).toBe('Painted from texture: 4 colors to filaments 17, 18, 19 and 20.')
    const e = get().plate[0]!
    expect(e.slotOverrides?.[e.handle.parts[0]!.name] ?? e.parts[0]!.slot).toBe(17)
    const texts = e.paint?.[0]?.color ?? {}
    const back = (await (await wasmGeom()).call<{ states: { state: number; areaMm2: number }[] }>('paint.regions', plain({ mesh: { positions: e.parts[0]!.positions, indices: e.parts[0]!.indices }, paint: texts }))).states
    expect(back.map((s) => s.state)).toEqual([18, 19, 20])
    expect(Object.values(texts).some((t) => t.includes('0FC'))).toBe(true)
    const bed = { widthMm: 256, depthMm: 256 }
    readProjectsWithGeom(false)
    try {
      const again = (await readProject(writeProject({ plates: allPlates(get()), bed }), bed)).plates[0]!.objects[0]!
      expect(again.paint?.[0]?.color).toEqual(texts)
    } finally {
      readProjectsWithGeom(true)
    }
  })

  it('paints a 3MF with texture2d groups, mirrored and clamped ones too', async () => {
    await addFileRefs(host, [ref('textured-cube.3mf')])
    const e = get().plate[0]!
    expect(get().toast?.text).toBe('Painted from texture: 4 colors to filaments 1, 2, 3 and 4.')
    // white covers the most here (900 mm2), so the part prints white
    expect(e.slotOverrides?.[e.handle.parts[0]!.name] ?? e.parts[0]!.slot).toBe(4)
    const back = (await (await wasmGeom()).call<{ states: { state: number; areaMm2: number }[] }>('paint.regions', plain({ mesh: { positions: e.parts[0]!.positions, indices: e.parts[0]!.indices }, paint: e.paint?.[0]?.color ?? {} }))).states
    expect(back.map((s) => [s.state, Math.round(s.areaMm2)])).toEqual([[1, 500], [2, 500], [3, 500]])
  })

  it('opens the OBJ alone with a note, and nothing is painted', async () => {
    await addFileRefs(host, [ref('textured-cube.obj')])
    expect(get().plate[0]!.paint).toBeUndefined()
    expect(get().toast?.text).toContain('textured-cube.mtl')
  })

  it('says what to do when only the MTL and image are opened', async () => {
    await addFileRefs(host, [ref('textured-cube.mtl'), ref('quadrants.png')])
    expect(get().plate).toHaveLength(0)
    expect(get().toast?.text).toContain('Open the OBJ together with its MTL and image files')
  })
})
