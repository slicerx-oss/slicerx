// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Body colors as data: a solid's color in the file comes back on its body, rides into OBJ vertex colors and STL facet
// colors, and a file without colors converts to exactly the bytes it did before colors were read at all.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadOcct, readStep, stepInfo, toObj, toStl, type Occt } from '../src/index.ts'

const file = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)))

let occt: Occt
beforeAll(async () => {
  occt = await loadOcct()
})

describe('body colors', () => {
  it('come back on the bodies the file colors, and only those', () => {
    const read = readStep(occt, file('assembly-colors.step'), 'assembly-colors.step')
    const bodies = read.objects.flatMap((o) => o.bodies)
    expect(bodies.map((b) => [b.name, b.color ?? null])).toEqual([
      ['base', '#ff0000'],
      ['post', null],
      ['cube', '#0040ff'],
    ])
  })

  it('go into OBJ as vertex colors on the colored bodies, and the rest of the text is unchanged', () => {
    const colored = readStep(occt, file('assembly-colors.step'), 'assembly.step')
    const plain = readStep(occt, file('assembly.step'), 'assembly.step')
    const obj = toObj(colored).split('\n')
    const base = obj.slice(obj.indexOf('g base') + 1, obj.indexOf('g post'))
    expect(base.filter((l) => l.startsWith('v ')).every((l) => l.endsWith(' 1 0 0'))).toBe(true)
    const post = obj.slice(obj.indexOf('g post') + 1, obj.indexOf('o cube'))
    expect(post.filter((l) => l.startsWith('v ')).every((l) => l.split(' ').length === 4)).toBe(true)
    const cube = obj.slice(obj.indexOf('g cube') + 1)
    expect(cube.filter((l) => l.startsWith('v ')).every((l) => l.endsWith(' 0 0.25098 1'))).toBe(true)
    // Without the colors it is the plain file's OBJ, byte for byte; so is the colored file with colors turned off.
    expect(obj.map((l) => (l.startsWith('v ') ? l.split(' ').slice(0, 4).join(' ') : l)).join('\n')).toBe(toObj(plain))
    expect(toObj(colored, { colors: false })).toBe(toObj(plain))
  })

  it('go into STL as facet colors (bit 15 set, 5 bits a channel), and an uncolored file writes zeros', () => {
    const colored = toStl(readStep(occt, file('assembly-colors.step'), 'a.step'))
    const plain = toStl(readStep(occt, file('assembly.step'), 'a.step'))
    expect(colored.length).toBe(plain.length)
    const attrs = (stl: Uint8Array) => {
      const v = new DataView(stl.buffer, stl.byteOffset, stl.byteLength)
      const n = v.getUint32(80, true)
      return Array.from({ length: n }, (_, i) => v.getUint16(84 + i * 50 + 48, true))
    }
    const red = 0x8000 | (31 << 10)
    const blue = 0x8000 | (8 << 5) | 31
    expect([...new Set(attrs(colored))].sort()).toEqual([0, red, blue].sort())
    expect(new Set(attrs(plain))).toEqual(new Set([0]))
    // Everything but the attribute bytes is the same.
    const strip = (stl: Uint8Array) => stl.filter((_, i) => i < 84 || (i - 84) % 50 < 48)
    expect(Buffer.from(strip(colored)).equals(Buffer.from(strip(plain)))).toBe(true)
  })

  it('are in the read-back info', () => {
    const info = stepInfo(readStep(occt, file('assembly-colors.step'), 'assembly.step'))
    expect(info.objects.map((o) => o.bodies.map((b) => b.color))).toEqual([['#ff0000', null], ['#0040ff']])
  })
})
