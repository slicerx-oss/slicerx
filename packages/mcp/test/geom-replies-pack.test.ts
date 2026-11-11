// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Recorded engine replies are kept packed: each long number array (a mesh's positions, indices and face ids) once, as
// binary. Unpacked they are the replies as recorded, byte for byte, so a replay hands the code under test the same
// meshes it got from the engine; a fixture written whole before still replays as it is.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PACKED_FORMAT, packReplies, sha256, unpackReplies, wholeText, type PackedReplies, type Recorded } from './geom-replies-pack'

const read = (name: string): unknown => JSON.parse(gunzipSync(readFileSync(join(__dirname, 'fixtures', name))).toString('utf8'))

describe('packed engine replies', () => {
  it('gives back the design sweep replies byte for byte as they were recorded whole', () => {
    const file = read('design-sweep-replies.json.gz') as PackedReplies
    expect(file.format).toBe(PACKED_FORMAT)
    const replies = unpackReplies(file)
    // `source` is the sha256 of the whole fixture's text before it was packed (pack-geom-replies.ts checked it then)
    expect(sha256(wholeText(replies))).toBe(file.source)
    // and the meshes are numbers again where the code reads them
    const sweep = Object.values(replies).flat().find((r) => r.op === 'sketch.sweep' && r.reply !== undefined)!.reply as { mesh: { positions: number[]; indices: number[] } }
    expect(sweep.mesh.positions.length % 3).toBe(0)
    expect(sweep.mesh.indices.every((i) => Number.isInteger(i) && i >= 0 && i < sweep.mesh.positions.length / 3)).toBe(true)
  })

  it('stores each long array once, in the narrowest binary that keeps every value, and leaves short ones inline', () => {
    const floats = Array.from({ length: 40 }, (_, i) => Math.fround(i * 0.37 - 5))
    const recorded: Record<string, Recorded[]> = {
      t: [
        { op: 'a', request: 'r1', reply: { mesh: { positions: floats, indices: Array.from({ length: 36 }, (_, i) => i), faces: Array.from({ length: 36 }, (_, i) => i - 5) }, tool: { positions: floats }, bounds: { min: [0, 0, 0], max: [1, 2, 3] } } },
        { op: 'b', request: 'r2', reply: { big: Array.from({ length: 33 }, (_, i) => 3_000_000_000 + i), fine: Array.from({ length: 33 }, (_, i) => i / 3), zero: [-0, ...Array.from({ length: 32 }, () => 1.5)], words: Array.from({ length: 40 }, () => 'x') } },
        { op: 'c', request: 'r3', error: 'refused' },
      ],
    }
    const packed = packReplies(recorded)
    const kinds = Object.values(packed.arrays).map((a) => a.t).sort()
    // positions once for mesh and tool; indices i32, faces i32, big u32, fine f64, the -0 one f64 (f32 would lose the sign)
    expect(kinds).toEqual(['f32', 'f64', 'f64', 'i32', 'i32', 'u32'])
    const reply = packed.replies['t']![0]!.reply as { mesh: { positions: unknown }; tool: { positions: unknown }; bounds: unknown }
    expect(reply.mesh.positions).toEqual(reply.tool.positions)
    expect(reply.bounds).toEqual({ min: [0, 0, 0], max: [1, 2, 3] })
    const back = unpackReplies(JSON.parse(JSON.stringify(packed)))
    expect(back).toEqual(recorded)
    expect(Object.is((back['t']![1]!.reply as { zero: number[] }).zero[0], -0)).toBe(true)
    expect(wholeText(back)).toBe(wholeText(recorded))
    expect(packed.source).toBe(sha256(wholeText(recorded)))
  })

  it('reads a fixture recorded whole as it is, and names an array a packed one lacks', () => {
    const whole = { t: [{ op: 'a', request: 'r', reply: { positions: [1, 2, 3] } }] }
    expect(unpackReplies(whole)).toBe(whole)
    expect(() => unpackReplies({ format: PACKED_FORMAT, source: 'x', arrays: {}, replies: { t: [{ op: 'a', request: 'r', reply: { positions: { $array: 'missing' } } }] } })).toThrow(/array missing/)
  })
})
