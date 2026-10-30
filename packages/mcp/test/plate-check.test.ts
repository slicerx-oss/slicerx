// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's plate check through the integrator path, with the real core: slicerx_project_show with check: true gives
// each by-object plate byObject.engine (what a slice would be refused for, each finding with its certainty, the pairs
// left with a sure strike, the fixes and what only the slice checks), off by default; slicerx_arrange checks the layout
// it made and says what is left. No new tool: the check rides on the two a client already calls.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxStl, connect, data, noSx, sxBin, type Harness } from './helpers'

type Res<T> = { ok?: boolean; summary: string; output: T; error?: { code: string; message: string } }
type Engine = {
  clean: boolean
  certainty: string[]
  collisions: { index: number; severity: string; object_id: string; hit_id: string; certainty: string; contact_point: number[] }[]
  leftSure: { a: { id: string; name: string }; b: { id: string; name: string }; collisions: number[] }[]
  fixes: { kind: string; order?: string[]; clears: number[] }[]
  unchecked: { objectId: string; what: string; near: string[] }[]
  order: string[]
  micros: number
}
type Shown = { plates: { index: number; placements: { id: string }[]; byObject?: { pairs: unknown[]; engine?: Engine } }[] }

async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Res<T>>(r)
  expect(r.isError, `${name}: ${JSON.stringify(d).slice(0, 400)}`).not.toBe(true)
  return d
}

/** Two 20 mm boxes on a P1S printed by object, their corners at x 110 and 110 + 20 + `gap`. */
async function pair(h: Harness, gap: number, changes: Record<string, unknown> = {}): Promise<string[]> {
  writeFileSync(join(h.dir, 'a.stl'), boxStl(20, 20, 10))
  writeFileSync(join(h.dir, 'b.stl'), boxStl(20, 20, 10))
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'a.stl') })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'b.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes: { skirt_loops: 0, brim_type: 'no_brim', print_sequence: 'by object', ...changes } })
  await call(h, 'slicerx_project_move', { object: 'obj-1', x: 120, y: 128 })
  await call(h, 'slicerx_project_move', { object: 'obj-2', x: 140 + gap, y: 128 })
  return (await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.placements.map((p) => p.id)
}

describe.skipIf(noSx())('the plate check over MCP', () => {
  it('runs on slicerx_project_show only when asked, and names a sure strike by id with its fixes', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const ids = await pair(h, 3)
      // Off by default: the footprint rule's plan only.
      const plain = (await call<Shown>(h, 'slicerx_project_show')).output.plates[0]!.byObject!
      expect(plain.pairs.length).toBeGreaterThan(0)
      expect(plain.engine).toBeUndefined()
      const e = (await call<Shown>(h, 'slicerx_project_show', { check: true })).output.plates[0]!.byObject!.engine!
      expect(e.clean).toBe(false)
      expect(e.certainty).toHaveLength(e.collisions.length)
      expect(e.collisions.every((c, i) => c.certainty === e.certainty[i])).toBe(true)
      // 3 mm apart, the head comes down on the first box: the slice is sure to refuse it.
      expect(e.leftSure).toHaveLength(1)
      expect([e.leftSure[0]!.a.id, e.leftSure[0]!.b.id].sort()).toEqual([...ids].sort())
      expect(e.leftSure[0]!.a.name).toEqual(expect.any(String))
      for (const c of e.collisions) expect(ids).toContain(c.object_id)
      // Fixes name the plate's own ids, never the engine's.
      for (const f of e.fixes) for (const id of f.order ?? []) expect(ids).toContain(id)
      expect(e.fixes.some((f) => f.kind === 'by_layer')).toBe(true)
      expect(e.unchecked).toEqual([])
      expect(e.order.sort()).toEqual([...ids].sort())
      expect(e.micros).toBeGreaterThan(0)
    } finally {
      await h.client.close()
    }
  })

  it('finds a plate clean when the objects are far apart, and checks nothing by layer', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      await pair(h, 90)
      const e = (await call<Shown>(h, 'slicerx_project_show', { check: true })).output.plates[0]!.byObject?.engine
      expect(e?.leftSure ?? []).toEqual([])
      expect(e?.collisions.filter((c) => c.severity === 'hit') ?? []).toEqual([])
      await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by layer' } })
      expect((await call<Shown>(h, 'slicerx_project_show', { check: true })).output.plates[0]!.byObject).toBeUndefined()
    } finally {
      await h.client.close()
    }
  })

  it('says what only the slice checks, with the objects near it', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const ids = await pair(h, 30, { enable_support: true, support_type: 'tree(auto)' })
      const e = (await call<Shown>(h, 'slicerx_project_show', { check: true })).output.plates[0]!.byObject!.engine!
      expect(e.unchecked.map((u) => u.what)).toContain('tree_support')
      for (const u of e.unchecked) {
        expect(ids).toContain(u.objectId)
        for (const n of u.near) expect(ids).toContain(n)
      }
      expect(e.clean).toBe(false)
    } finally {
      await h.client.close()
    }
  })

  it('checks the layout slicerx_arrange made and returns the pairs it left with the fixes', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      // Both boxes were placed by hand, so the arrange keeps them where they are: the strike stays, and arrange says so.
      const ids = await pair(h, 3)
      const r = await call<{ check?: ({ plate: number } & Engine)[]; leftSure?: { plate: number; a: { id: string }; b: { id: string } }[] }>(h, 'slicerx_arrange')
      expect(r.output.check, r.summary).toBeDefined()
      const c = r.output.check![0]!
      expect(c.plate).toBe(1)
      expect(c.certainty).toHaveLength(c.collisions.length)
      expect(c.fixes.some((f) => f.kind === 'by_layer')).toBe(true)
      expect(Array.isArray(c.unchecked)).toBe(true)
      expect(r.output.leftSure!.map((p) => [p.plate, ...[p.a.id, p.b.id].sort()])).toEqual([[1, ...[...ids].sort()]])
      expect(r.summary).toMatch(/would still be refused/)
    } finally {
      await h.client.close()
    }
  })

  it('finds nothing left when the arrange places the copies itself', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      writeFileSync(join(h.dir, 'a.stl'), boxStl(20, 20, 10))
      await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
      await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'a.stl') })
      await call(h, 'slicerx_project_set_overrides', { changes: { skirt_loops: 0, brim_type: 'no_brim', print_sequence: 'by object' } })
      const r = await call<{ check?: ({ plate: number } & Engine)[]; leftSure?: unknown[] }>(h, 'slicerx_arrange', { count: 3 })
      expect(r.output.check, r.summary).toHaveLength(1)
      expect(r.output.leftSure).toEqual([])
      expect(r.summary).not.toMatch(/refused/)
    } finally {
      await h.client.close()
    }
  })
})
