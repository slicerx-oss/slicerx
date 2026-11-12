// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.look measures a change by decoding two pictures and counting the pixels that changed. The app runs it in its
// page, where there is no Buffer and node:zlib is an empty stub, so the decoder uses neither: these tests run it with
// Buffer gone and with node:zlib stubbed the way the packaged app stubs it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changedShare, decodePng } from '../src/look'

/** A zlib stream of `data`, made with the platform's CompressionStream (no node builtin). */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')).getReader()
  const parts: number[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return new Uint8Array(parts)
    parts.push(...value)
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
function chunk(type: string, data: Uint8Array): number[] {
  const td = new Uint8Array([...type].map((c) => c.charCodeAt(0)).concat([...data]))
  return [...be(data.length), ...td, ...be(crc32(td))]
}

/** An 8-bit PNG, RGB (ch 3) or RGBA (ch 4), of `w` by `h` pixels colored by `at`, as base64; each row uses filter `filter`. */
async function png(w: number, h: number, ch: 3 | 4, at: (x: number, y: number) => number[], filter = 0): Promise<string> {
  const rows: number[] = []
  for (let y = 0; y < h; y++) {
    rows.push(filter)
    const line = Array.from({ length: w }, (_, x) => at(x, y).slice(0, ch)).flat()
    // filter 1 (sub): each byte less the one a pixel to its left
    rows.push(...(filter === 1 ? line.map((v, i) => (v - (i >= ch ? line[i - ch]! : 0)) & 255) : line))
  }
  const ihdr = new Uint8Array([...be(w), ...be(h), 8, ch === 4 ? 6 : 2, 0, 0, 0])
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...chunk('IDAT', await deflate(new Uint8Array(rows))), ...chunk('IEND', new Uint8Array())]
  return btoa(String.fromCharCode(...bytes))
}

const WHITE = [255, 255, 255, 255]
/** A round mug seen from above: a red disc of radius 8 centered on a 32 px square. */
const mug = (x: number, y: number) => ((x - 16) ** 2 + (y - 16) ** 2 <= 64 ? [200, 30, 30, 255] : WHITE)
/** A flat shelf seen from the front: a blue bar 20 by 4 px, with a 4 px green block on it when `book` is set. */
const shelf = (book: boolean) => (x: number, y: number) => (y >= 20 && y < 24 && x >= 6 && x < 26 ? [30, 60, 200, 255] : book && y >= 16 && y < 20 && x >= 10 && x < 14 ? [30, 160, 60, 255] : WHITE)

describe('the look decoder in a page with no Buffer', () => {
  const saved = globalThis.Buffer
  beforeEach(() => {
    // the app's page has no Buffer
    delete (globalThis as { Buffer?: unknown }).Buffer
  })
  afterEach(() => {
    globalThis.Buffer = saved
  })

  it('decodes an RGB picture of a mug and an RGBA picture of a shelf, filtered either way', async () => {
    const a = await png(32, 32, 3, mug)
    expect(typeof globalThis.Buffer).toBe('undefined')
    const m = (await decodePng(a))!
    expect(m).toMatchObject({ w: 32, h: 32, ch: 3 })
    expect([...m.px.subarray((16 * 32 + 16) * 3, (16 * 32 + 16) * 3 + 3)]).toEqual([200, 30, 30])
    expect([...m.px.subarray(0, 3)]).toEqual([255, 255, 255])
    const s = (await decodePng(await png(32, 32, 4, shelf(true), 1)))!
    expect(s).toMatchObject({ w: 32, h: 32, ch: 4 })
    expect([...s.px.subarray((21 * 32 + 8) * 4, (21 * 32 + 8) * 4 + 4)]).toEqual([30, 60, 200, 255])
    expect([...s.px.subarray((17 * 32 + 11) * 4, (17 * 32 + 11) * 4 + 4)]).toEqual([30, 160, 60, 255])
    // not a PNG, or a broken one: null, never a throw
    expect(await decodePng(btoa('not a picture'))).toBeNull()
    expect(await decodePng(a.slice(0, 40))).toBeNull()
  })

  it('measures the share that changed: none for the same mug, the added block for the shelf', async () => {
    const cup = await png(32, 32, 3, mug)
    expect(await changedShare(cup, cup)).toBe(0)
    const before = await png(32, 32, 4, shelf(false))
    const after = await png(32, 32, 4, shelf(true))
    // 80 bar pixels before and after, plus 16 block pixels after: 16 of 96 covered pixels changed
    expect(await changedShare(before, after)).toBeCloseTo((16 / 96) * 100, 6)
    // pictures of two sizes cannot be compared
    expect(await changedShare(cup, await png(16, 16, 3, mug))).toBeNull()
  })
})

describe('the look module where node:zlib is an empty stub', () => {
  afterEach(() => {
    vi.doUnmock('node:zlib')
    vi.resetModules()
  })

  it('loads and decodes', async () => {
    vi.resetModules()
    // the packaged app stubs node:zlib as {}
    vi.doMock('node:zlib', () => ({}))
    const look = await import('../src/look')
    const cup = await png(32, 32, 3, mug)
    expect((await look.decodePng(cup))?.w).toBe(32)
    expect(await look.changedShare(cup, cup)).toBe(0)
  })
})
