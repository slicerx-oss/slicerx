// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a new hole's line leaves the part. When it leaves on an edge where a face square to the axis meets a slanted
// one, both crossings are at one depth, and either can come first by rounding alone. The square face is taken, so the
// hole is not refused for a slanted face that only meets the line at that edge. A line that truly leaves on a slanted
// face is read as before.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cadTools, holeExit } from '../src/cad'
import { Designs } from '../src/design'
import { connect, text } from './helpers'

type V3 = [number, number, number]
const up: V3 = [0, 1, 0]
const slanted: V3 = [-0.92, -0.391, 0]

describe('where a hole leaves the part', () => {
  it('takes the face square to the axis over a slanted face at the same depth, even when the slanted one is nearer by rounding', () => {
    const hits = [{ s: 0, n: [0, -1, 0] as V3 }, { s: 15, n: slanted }, { s: 15.000000000000002, n: up }, { s: 30, n: up }]
    expect(holeExit(hits, 0, up, up)).toEqual({ d: 15.000000000000002, n: up })
    // the same with the axis given the other way round
    const back = hits.map((h) => ({ s: -h.s, n: h.n }))
    expect(holeExit(back, 0, [0, -1, 0], up)).toEqual({ d: 15.000000000000002, n: up })
  })

  it('reads the end of a round post with a swept bar joined on it at 15 mm, though a bar facet crosses first', () => {
    // the crossings along the axis of a post 15 mm long whose bar starts at the middle of its end, leaning off it
    const hits: { s: number; n: V3 }[] = [
      { s: 0, n: [0, -1, 0] },
      { s: 15, n: up },
      { s: 15.000000000000002, n: [-0.9201782438480788, -0.39149968013865033, 0] },
      { s: 15, n: [-0.920177295714139, -0.3915019086188645, 0] },
      { s: 14.999999999999998, n: [-0.9201773594114345, -0.39150175890611977, 1.1935166185779512e-7] },
      { s: 21.519399008624436, n: [-0.390838420697111, 0.9196209248085895, -0.039277010593763324] },
    ]
    expect(holeExit(hits, 0, up, up)).toEqual({ d: 15, n: up })
  })

  it('keeps the slanted face when no square face is at that depth', () => {
    expect(holeExit([{ s: 0, n: [0, -1, 0] }, { s: 15, n: slanted }, { s: 15.001, n: up }], 0, up, up)).toEqual({ d: 15, n: slanted })
    expect(holeExit([{ s: 0, n: [0, -1, 0] }, { s: 15, n: slanted }], 0, up, up)).toEqual({ d: 15, n: slanted })
    expect(holeExit([{ s: 0, n: [0, -1, 0] }], 0, up, up)).toBeUndefined()
  })
})

// a post 20 mm square and 15 mm tall along +y, with a bar leaning over it joined on its end: the bar's slanted face
// and the post's end meet on the edge through the post's middle, listed slanted face first
const outline: [number, number][] = [[-10, 0], [10, 0], [10, 15], [4, 29], [-6, 29], [0, 15], [-10, 15]]
const fans: [number, number, number][] = [[0, 1, 2], [0, 2, 5], [0, 5, 6], [5, 2, 3], [5, 3, 4]]

function postWithBar(): { name: string; slot: number; positions: number[]; indices: number[] } {
  const positions: number[] = []
  for (const z of [-10, 10]) for (const [x, y] of outline) positions.push(x, y, z)
  const n = outline.length
  const indices: number[] = []
  for (const [a, b, c] of fans) indices.push(a, c, b, a + n, b + n, c + n)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    indices.push(i, j, j + n, i, j + n, i + n)
  }
  // the slanted face (from (-6, 29) to (0, 15)) ahead of the post's end (from (0, 15) to (-10, 15))
  return { name: 'Post', slot: 1, positions, indices }
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('a hole into the end of a post with a slanted bar joined on it', () => {
  it('goes through the post to its end, not refused for the bar\'s slanted face on that edge', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'hole-exit-')); dirs.push(outDir)
    const asked: { op: string; request: unknown }[] = []
    const engine = vi.fn(async (op: string, request: unknown) => {
      asked.push({ op, request })
      throw new Error(`no ${op} here`)
    })
    const designs = new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } })
    const d = await designs.create('Post', [postWithBar()])
    const unused = async (): Promise<never> => { throw new Error('must not read a file') }
    const h = await connect({ extraTools: cadTools({ designs, files: { engine: false, call: unused, path: unused, stl: () => { throw new Error('must not read an STL') } } }) })
    const r = await h.call('slicerx_geom_hole', { design: d.id, center: [0, 0, 0], axis: [0, 1, 0], diameter_mm: 4.5 })
    expect(text(r)).not.toMatch(/not closed along/)
    // the cut is asked for through the post's 15 mm, and a little past its end
    const cut = asked.find((x) => x.op !== 'hole.find')
    expect(cut, JSON.stringify(asked.map((x) => x.op))).toBeDefined()
    expect(JSON.stringify(cut!.request)).toContain('"distanceMm":15.05')
  })
})
