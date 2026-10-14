// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exact solids in history replays (developer flag): a box, a hole through it and a cut across it, replayed in the
// geometry worker with the flag on (the B-rep kernel, loaded lazily) and off (the mesh engine). Both must give the same
// part; the kernel's must be closer to the exact volume, with no step falling back. The times of both go into the
// report, so a slowdown on either path shows.
import { type Page } from '@playwright/test'
import { command, openStudio } from './cad-helpers'
import { expect, test } from './fixtures'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const frame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

/** The steps, named for each run: the replay cache keys on what a step does, so a run of its own misses it. */
function steps(run: string, upTo: number): unknown[] {
  const all = [
    { id: `box-${run}`, part: 0, transform: IDENTITY, params: { op: 'shape.extrude', frame, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, spec: { distanceMm: 20, operation: 'new' }, name: `Box ${run}` } },
    { id: `hole-${run}`, part: 0, transform: IDENTITY, params: { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 8, heightMm: 20 }], label: 'Hole 8 mm' } },
    { id: `cut-${run}`, part: 0, transform: IDENTITY, params: { op: 'plane.cut', plane: { point: [0, 0, 8], normal: [0, 0, 1] }, keep: 'below' } },
  ]
  return all.slice(0, upTo)
}

const EXACT = [8000, 8000 - Math.PI * 16 * 20, (400 - Math.PI * 16) * 8]

interface Run {
  ms: number
  volume: number
  states: string[]
  fellBack: string[]
  bounds: number[]
}

function replay(page: Page, run: string, upTo: number, exact: boolean): Promise<Run> {
  return page.evaluate(
    async ({ history, exact }) => {
      const g = (window as unknown as { __geom: { call(op: string, r: unknown): Promise<unknown> } }).__geom
      const t0 = performance.now()
      const r = (await g.call('history.replay', { history, exact })) as { parts: { positions: number[]; indices: number[] }[]; status: { state: string }[]; exactFellBack?: string[] }
      const ms = performance.now() - t0
      if (!r.parts[0]) throw new Error(`no part: ${JSON.stringify(r.status)}`)
      const { positions: p, indices: ix } = r.parts[0]
      let volume = 0
      for (let i = 0; i < ix.length; i += 3) {
        const [a, b, c] = [ix[i]! * 3, ix[i + 1]! * 3, ix[i + 2]! * 3]
        volume += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6
      }
      const bounds = [0, 1, 2].flatMap((k) => {
        let lo = Infinity
        let hi = -Infinity
        for (let i = k; i < p.length; i += 3) {
          lo = Math.min(lo, p[i]!)
          hi = Math.max(hi, p[i]!)
        }
        return [lo, hi]
      })
      return { ms, volume, states: r.status.map((s) => s.state), fellBack: r.exactFellBack ?? [], bounds }
    },
    { history: { version: 1, base: [], steps: steps(run, upTo) }, exact },
  )
}

test.describe('Exact solids', () => {
  test.skip(({ isMobile }) => isMobile, 'A developer flag on the desktop layout')

  test('the developer command turns the flag on and off', async ({ page }) => {
    await openStudio(page, { settingsMode: 'developer' })
    await command(page, 'Developer: exact solids in history replays')
    await expect(page.getByText('Exact solids are on for history replays.')).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('sx.exactSolids'))).toBe('1')
    await command(page, 'Developer: exact solids in history replays')
    await expect(page.getByText('Exact solids are off.')).toBeVisible()
  })

  test('box, hole and cut replay the same on the kernel and the mesh, and both are timed', async ({ page }, info) => {
    await openStudio(page, { settingsMode: 'developer' })
    const names = ['box', 'box and hole', 'box, hole and cut']
    for (let n = 1; n <= 3; n++) {
      // the first exact replay also loads the kernel; time a second one too
      const first = await replay(page, `x${n}a`, n, true)
      const exact = await replay(page, `x${n}b`, n, true)
      const mesh = await replay(page, `m${n}`, n, false)
      for (const r of [first, exact, mesh]) expect(r.states).toEqual(Array(n).fill('done'))
      expect(exact.fellBack).toEqual([])
      const want = EXACT[n - 1]!
      expect(Math.abs(exact.volume - want) / want).toBeLessThan(1e-3)
      expect(Math.abs(exact.volume - want)).toBeLessThanOrEqual(Math.abs(mesh.volume - want) + 1e-6)
      exact.bounds.forEach((b, k) => expect(Math.abs(b - mesh.bounds[k]!)).toBeLessThan(1e-3))
      const line = `${names[n - 1]}: kernel ${exact.ms.toFixed(0)} ms (first ${first.ms.toFixed(0)} ms), mesh ${mesh.ms.toFixed(0)} ms; volume off exact ${(exact.volume - want).toFixed(4)} vs ${(mesh.volume - want).toFixed(4)} mm3`
      info.annotations.push({ type: 'timing', description: line })
      console.log(line)
    }
  })

  test('a missing face reference stops the worker replay for repair on both engines', async ({ page }) => {
    await openStudio(page, { settingsMode: 'developer' })
    for (const exact of [false, true]) {
      const result = await page.evaluate(async ({ baseSteps, exact, transform }) => {
        const g = (window as unknown as { __geom: { call(op: string, r: unknown): Promise<unknown> } }).__geom
        type Reply = { parts: { positions: number[]; indices: number[]; faceKeys?: number[] }[]; status: { state: string; message?: string }[]; exactFellBack?: string[] }
        const history = { version: 2, base: [], steps: baseSteps }
        const before = await g.call('history.replay', { history, exact }) as Reply
        const after = await g.call('history.replay', { history: { ...history, steps: [...baseSteps, {
          id: `missing-${exact}`, part: 0, transform,
          params: { op: 'face.push', at: [0, 0, 20], normal: [0, 0, 1], distanceMm: 1, faceKey: 1 },
        }] }, exact }) as Reply
        return { before, after }
      }, { baseSteps: steps(`repair-${exact}`, 1), exact, transform: IDENTITY })
      expect(result.before.status.map((s) => s.state)).toEqual(['done'])
      expect(result.after.status[1]).toMatchObject({ state: 'broken', message: expect.stringMatching(/missing.*repair/i) })
      expect(result.after.exactFellBack ?? []).toEqual([])
      expect(result.after.parts[0]?.positions).toEqual(result.before.parts[0]?.positions)
      expect(result.after.parts[0]?.indices).toEqual(result.before.parts[0]?.indices)
    }
  })
})
