// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening textured models next to others: only what an open adds is painted, a step each; a failed open paints
// nothing; a desktop host reads an OBJ's MTL and image from its folder; a project picture is no texture; parts that
// share a name keep every filament as paint; and a texture source goes when its object leaves the project. The live
// cases run the real geometry engine (packages/geom/wasm/pkg); they skip without one, except on CI.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FileRef, Host, MeshHandle, MeshPart } from '@slicerx/contracts'
import { setGeomProvider } from '../src/geom/client'
import { history } from '../src/plate/history'
import { textureBefore } from '../src/plate/texture-open'
import { forgetTexture, planTexturePaint, rememberTexture, TEXTURE_FAILED, textureSourceOf, type TextureSource } from '../src/plate/texture-paint'
import { addFileRefs } from '../src/state/open-models'
import { appStore, get, set, type PlateEntry } from '../src/state/store'
import { liveEngine, wasmGeom } from './geom-engine'

const dir = join(__dirname, '..', '..', 'geom', 'tests', 'fixtures', 'texture')
const RGBW = ['#e6141e', '#14c828', '#1428dc', '#f5f5f5']
const PAINTED = 'Painted from texture: 4 colors to filaments 1, 2, 3 and 4.'

function plain(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, plain(e)]))
  return v
}

/** A ZIP of stored entries. */
function zipStored(files: [string, string][]): ArrayBuffer {
  const enc = new TextEncoder()
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const out: number[] = []
  const dirBytes: number[] = []
  const u16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff)
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  for (const [name, text] of files) {
    const n = enc.encode(name)
    const d = enc.encode(text)
    const at = out.length
    const head = (a: number[], central: boolean) => {
      u32(a, central ? 0x02014b50 : 0x04034b50)
      if (central) u16(a, 20)
      for (const v of [20, 0, 0, 0, 0]) u16(a, v)
      u32(a, crc(d))
      u32(a, d.length)
      u32(a, d.length)
      u16(a, n.length)
      u16(a, 0)
      if (central) {
        for (const v of [0, 0, 0]) u16(a, v)
        u32(a, 0)
        u32(a, at)
      }
      a.push(...n)
    }
    head(out, false)
    out.push(...d)
    head(dirBytes, true)
  }
  const start = out.length
  out.push(...dirBytes)
  u32(out, 0x06054b50)
  for (const v of [0, 0, files.length, files.length]) u16(out, v)
  u32(out, dirBytes.length)
  u32(out, start)
  u16(out, 0)
  return new Uint8Array(out).buffer
}

describe('texture sources and 3MF pictures', () => {
  const src: TextureSource = { kind: '3mf', name: 'a.3mf', data: new Uint8Array(1) }
  const entry = (id: string) => ({ id, name: id, handle: { id, parts: [] }, parts: [], colors: [], transform: [] }) as unknown as PlateEntry
  beforeEach(() => set({ plate: [], plates: [{ id: 'p', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p' }))

  it('lets a source go when its object leaves, on a new project, or when told', () => {
    set({ plate: [entry('a'), entry('b')] })
    rememberTexture('a', src)
    rememberTexture('b', src)
    set({ plate: [entry('b')] })
    expect(textureSourceOf('a')).toBeUndefined()
    expect(textureSourceOf('b')).toBe(src)
    forgetTexture('b')
    expect(textureSourceOf('b')).toBeUndefined()
    rememberTexture('b', src)
    set({ plate: [] })
    expect(textureSourceOf('b')).toBeUndefined()
    // an object not in the project is not kept at all
    rememberTexture('c', src)
    expect(textureSourceOf('c')).toBeUndefined()
  })

  it('reads at most 64 files from the OBJ folder and holds each read to what is left of the byte cap', async () => {
    const MAX_BESIDE_FILES = 64
    const MAX_TEXTURE_BYTES = 256 * 1024 * 1024
    const enc = new TextEncoder()
    const obj = enc.encode('mtllib a.mtl\nv 0 0 0\n')
    const mtl = enc.encode(Array.from({ length: 100 }, (_, i) => `newmtl m${i}\nmap_Kd t${i}.png\n`).join(''))
    const asked: { name: string; max: number | undefined }[] = []
    const host = {
      files: {
        read: async () => new ArrayBuffer(0),
        readBeside: async (_r: FileRef, name: string, max?: number) => {
          asked.push({ name, max })
          return name === 'a.mtl' ? mtl.slice().buffer : new Uint8Array([1, 2, 3]).buffer
        },
      },
    } as unknown as Host
    const ref: FileRef = { id: '1', name: 'a.obj', size: obj.length, path: '/m/a.obj' }
    const src = await textureBefore(host, 'a.obj', obj.slice().buffer, [], ref)
    expect(asked).toHaveLength(MAX_BESIDE_FILES)
    expect(asked[0]).toEqual({ name: 'a.mtl', max: MAX_TEXTURE_BYTES })
    expect(asked[1]!.max).toBe(MAX_TEXTURE_BYTES - mtl.length)
    expect(asked[2]!.max).toBe(MAX_TEXTURE_BYTES - mtl.length - 3)
    expect(src?.kind === 'obj' ? Object.keys(src.files) : []).toHaveLength(MAX_BESIDE_FILES)
  })

  it('drops a file the host hands back over the cap it was asked for', async () => {
    const enc = new TextEncoder()
    const obj = enc.encode('mtllib a.mtl\nv 0 0 0\n')
    const mtl = enc.encode('newmtl m\nmap_Kd big.png\n')
    // a host that does not keep to the cap: the answer is longer than asked for
    const host = { files: { read: async () => new ArrayBuffer(0), readBeside: async (_r: FileRef, name: string, max = 0) => (name === 'a.mtl' ? mtl.slice().buffer : { byteLength: max + 1 }) } } as unknown as Host
    const ref: FileRef = { id: '1', name: 'a.obj', size: obj.length, path: '/m/a.obj' }
    const src = await textureBefore(host, 'a.obj', obj.slice().buffer, [], ref)
    expect(src).toBeNull()
  })

  it('keeps a 3MF only when a model file uses a texture, not for a model picture', async () => {
    const host = {} as Host
    const model = (body: string) => `<model><resources>${body}</resources></model>`
    const picture = zipStored([['3D/3dmodel.model', model('<object id="1"/>')], ['Auxiliaries/Model Pictures/a.png', 'png']])
    expect(await textureBefore(host, 'pictured.3mf', picture, [])).toBeNull()
    const textured = zipStored([['3D/3dmodel.model', model('<m:texture2d id="1" path="/3D/Texture/a.png"/><m:texture2dgroup id="2" texid="1"></m:texture2dgroup>')], ['3D/Texture/a.png', 'png']])
    expect((await textureBefore(host, 'textured.3mf', textured, []))?.kind).toBe('3mf')
  })
})

describe.skipIf(!liveEngine)('textured models opened next to others', () => {
  const slicer = {
    loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), bboxMm: [20, 20, 20], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })) }),
    release: () => undefined,
  }
  const bytes = new Map<string, Uint8Array>()
  const host = { slicer, files: { read: async (r: FileRef) => bytes.get(r.name)!.slice().buffer } } as unknown as Host
  const ref = (name: string): FileRef => {
    bytes.set(name, new Uint8Array(readFileSync(join(dir, name))))
    return { id: name, name, size: bytes.get(name)!.length }
  }
  const stl = (name: string): FileRef => {
    bytes.set(name, new TextEncoder().encode('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n'))
    return { id: name, name, size: bytes.get(name)!.length }
  }
  const textured = () => [ref('textured-cube.obj'), ref('textured-cube.mtl'), ref('quadrants.png')]
  const watch = () => {
    const toasts: string[] = []
    const off = appStore.subscribe((s, p) => {
      if (s.toast && s.toast !== p.toast) toasts.push(s.toast.text)
    })
    return { toasts, off }
  }
  let live: (op: string, request: unknown) => Promise<unknown>

  beforeAll(async () => {
    const wasm = await wasmGeom()
    live = (op, request) => wasm.call(op, plain(request))
    setGeomProvider({ call: live as never })
  })
  afterAll(() => setGeomProvider(null))
  beforeEach(() => {
    set({ plate: [], plates: [{ id: 'p', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p', printerSlots: [], fileSlotColors: [], slotSetup: Object.fromEntries(RGBW.map((color, i) => [i + 1, { type: 'PLA', brand: '', color }])), toast: null })
    history().clear()
  })

  it('paints only the textured OBJ of an open that also has a plain model', async () => {
    const w = watch()
    await addFileRefs(host, [...textured(), stl('plain.stl')])
    w.off()
    expect(get().plate).toHaveLength(2)
    const cube = get().plate.find((e) => /textured/.test(e.name))!
    const other = get().plate.find((e) => e !== cube)!
    expect(Object.keys(cube.paint?.[0]?.color ?? {}).length).toBeGreaterThan(0)
    expect(other.paint).toBeUndefined()
    expect(textureSourceOf(other.id)).toBeUndefined()
    expect(w.toasts.filter((t) => t === PAINTED)).toHaveLength(1)
  })

  it('paints two textured models of one open as a step each, and Add model leaves them as they are', async () => {
    const w = watch()
    await addFileRefs(host, [...textured(), ref('textured-cube.3mf')])
    expect(w.toasts.filter((t) => t === PAINTED)).toHaveLength(2)
    const [a, b] = get().plate
    const paintA = a!.paint
    expect(paintA?.[0]?.color).toBeDefined()
    expect(b!.paint?.[0]?.color).toBeDefined()
    // the second one's Undo leaves the first painted
    history().undo()
    expect(get().plate.find((e) => e.id === a!.id)!.paint).toEqual(paintA)
    expect(get().plate.find((e) => e.id === b!.id)!.paint).toBeUndefined()
    // Add model of another textured file paints only what it adds
    await addFileRefs(host, [ref('textured-cube.3mf')], { fresh: false })
    w.off()
    expect(get().plate).toHaveLength(3)
    expect(get().plate.find((e) => e.id === a!.id)!.paint).toEqual(paintA)
    expect(get().plate.find((e) => e.id === b!.id)!.paint).toBeUndefined()
    expect(w.toasts.filter((t) => t === PAINTED)).toHaveLength(3)
  })

  it('paints nothing when the open fails', async () => {
    const broken = { ...host, files: { read: async (r: FileRef) => (r.name.endsWith('.obj') ? Promise.reject(new Error('gone')) : bytes.get(r.name)!.slice().buffer) } } as unknown as Host
    const w = watch()
    await addFileRefs(broken, textured())
    w.off()
    expect(w.toasts).not.toContain(PAINTED)
    expect(get().plate.every((e) => !e.paint)).toBe(true)
  })

  it('says in plain words that the texture could not be painted when the engine fails', async () => {
    setGeomProvider({ call: ((op: string, request: unknown) => (op === 'paint.texture' ? Promise.reject(new Error('paint.texture: filaments: 1 to 16 colors')) : live(op, request))) as never })
    try {
      await addFileRefs(host, textured())
    } finally {
      setGeomProvider({ call: live as never })
    }
    expect(get().toast?.text).toBe(TEXTURE_FAILED)
    expect(get().plate[0]!.paint).toBeUndefined()
  })

  it('reads the MTL and the image from the OBJ folder on a desktop host', async () => {
    const asked: string[] = []
    const desk = { ...host, files: { ...host.files, readBeside: async (_r: FileRef, name: string) => (asked.push(name), bytes.has(name) ? bytes.get(name)!.slice().buffer : null) } } as unknown as Host
    ref('textured-cube.mtl')
    ref('quadrants.png')
    await addFileRefs(desk, [{ ...ref('textured-cube.obj'), path: '/models/textured-cube.obj' }])
    expect(asked).toEqual(['textured-cube.mtl', 'quadrants.png'])
    expect(get().toast?.text).toBe(PAINTED)
    expect(textureSourceOf(get().plate[0]!.id)).toBeDefined()
  })

  it('keeps every filament as paint on parts that share a name, and sets no part filament for them', async () => {
    await addFileRefs(host, textured())
    const e = get().plate[0]!
    const part = e.parts[0]!
    const src = textureSourceOf(e.id)!
    const { paint: _paint, ...bare } = e
    const plan = await planTexturePaint({ ...bare, parts: [part, { ...part }] }, src, 'nearest', RGBW)
    expect(plan.slots).toEqual({})
    for (const i of [0, 1]) {
      const texts = Object.fromEntries((plan.edits.find((x) => x.partIndex === i)?.edits ?? []).map((x) => [x.triangle, x.after]))
      const back = (await live('paint.regions', { mesh: { positions: part.positions, indices: part.indices }, paint: texts })) as { states: { state: number }[] }
      expect(back.states.map((s) => s.state)).toEqual([1, 2, 3, 4])
    }
    // a part with a name of its own takes the filament with the most area as its own
    expect((await planTexturePaint(bare, src, 'nearest', RGBW)).slots).toEqual({ 0: 1 })
  })
})
