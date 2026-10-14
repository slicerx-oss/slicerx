// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('design-reorder-replies')
beforeEach(() => clearReplayCache())
type Row = { id: string; index: number; state: string; follows: { step: string }[]; message?: string }
type ReadBack = { design: string; sizeMm: number[]; steps: Row[]; detached?: { step: string; followed: string }[] }

describe('a client reorders design features', () => {
  it('reindexes a split and a later edit against the actual replayed pieces', async () => {
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
    const call = async (name: string, args = {}) => {
      const r = await h.call(`slicerx_${name}`, args)
      expect(r.isError, text(r)).not.toBe(true)
      return data<{ output: ReadBack & { parts: { name: string; sizeMm: number[] }[] } }>(r).output
    }
    try {
      const design = (await call('design_new')).design
      await call('geom_extrude', { design, name: 'Base', shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      await call('geom_split', { design, build_volume_mm: [10, 10, 10], margin_mm: 0 })
      await call('geom_extrude', { design, name: 'Peg', shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, frame: { origin: [30, 0, 0], normal: [0, 0, 1] }, distance_mm: 2 })
      await call('geom_push_pull', { design, face: { at: [30, 0, 2], normal: [0, 0, 1] }, distance_mm: 1 })
      const before = await call('design_steps', { design })
      expect(before.parts.length).toBeGreaterThan(2)
      const changed = await call('design_reorder_step', { design, step: 3, to: 2 })
      expect(changed.parts).toEqual(before.parts)
      expect(changed.parts.find((p) => p.name === 'Peg')!.sizeMm).toEqual([4, 4, 3])
      expect(changed.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
    } finally { await h.client.close() }
  })

  it('moves body creation without replacing a body or redirecting later edits', async () => {
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
    const call = async (name: string, args = {}) => {
      const r = await h.call(`slicerx_${name}`, args)
      expect(r.isError, text(r)).not.toBe(true)
      return data<{ output: ReadBack & { volumeMm3: number; parts: { name: string; sizeMm: number[] }[] } }>(r).output
    }
    try {
      const design = (await call('design_new')).design
      await call('geom_extrude', { design, name: 'Base', shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      await call('geom_extrude', { design, name: 'Peg', shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, frame: { origin: [30, 0, 0], normal: [0, 0, 1] }, distance_mm: 2 })
      await call('geom_push_pull', { design, face: { at: [0, 0, 3], normal: [0, 0, 1] }, distance_mm: 2 })
      const original = await call('design_steps', { design })
      const changed = await call('design_reorder_step', { design, step: 2, to: 1 })
      expect(changed.steps.map((s) => s.id)).toEqual([original.steps[1]!.id, original.steps[0]!.id, original.steps[2]!.id])
      expect(changed.parts).toHaveLength(2)
      expect(changed.sizeMm).toEqual(original.sizeMm)
      expect(changed.volumeMm3).toBeCloseTo(original.volumeMm3, 3)
      expect(changed.parts.find((p) => p.name === 'Base')!.sizeMm).toEqual([20, 10, 5])
      expect(changed.parts.find((p) => p.name === 'Peg')!.sizeMm).toEqual([4, 4, 2])
      expect((await call('design_steps', { design })).steps).toEqual(changed.steps)
      const restored = await call('design_reorder_step', { design, step: 1, to: 2 })
      expect(restored.parts).toEqual(original.parts)
    } finally { await h.client.close() }
  })

  it('reads detached references and broken steps, repairs the order, and saves it', async () => {
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
    const call = async (name: string, args = {}) => {
      const r = await h.call(`slicerx_${name}`, args)
      expect(r.isError, text(r)).not.toBe(true)
      return data<{ output: ReadBack }>(r).output
    }
    try {
      const design = (await call('design_new', { name: 'Boss' })).design
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 6, heightMm: 6 }, frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, distance_mm: 4, operation: 'join' })
      await call('geom_push_pull', { design, face: { at: [0, 0, 7], normal: [0, 0, 1] }, distance_mm: 2 })
      const original = await call('design_steps', { design })
      expect(original.sizeMm).toEqual([20, 10, 9])
      const [base, boss, push] = original.steps
      expect(push!.follows).toEqual(expect.arrayContaining([expect.objectContaining({ step: boss!.id })]))

      await call('design_undo', { design })
      expect((await h.call('slicerx_design_reorder_step', { design, step: base!.id, to: 2 })).isError).toBe(true)
      await call('design_reorder_step', { design, step: 1, to: 1 })
      await call('design_redo', { design })
      expect((await call('design_steps', { design })).steps).toEqual(original.steps)
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 2, heightMm: 2 }, frame: { origin: [30, 0, 0], normal: [0, 0, 1] }, distance_mm: 2, operation: 'new' })
      await call('design_undo', { design })

      const broken = await h.call('slicerx_design_reorder_step', { design, step: push!.id, to: 2 })
      expect(data<{ ok: boolean }>(broken).ok).toBe(false)
      const failed = data<{ output: ReadBack }>(broken).output
      expect(failed.steps.map((s) => s.id)).toEqual([base!.id, push!.id, boss!.id])
      expect(failed.steps.map((s) => s.state)).toEqual(['done', 'broken', 'skipped'])
      expect(failed.steps[1]!.message).toBeTruthy()
      expect(failed.detached).toEqual([expect.objectContaining({ step: push!.id, followed: boss!.id })])
      expect((await h.call('slicerx_design_redo', { design })).isError).toBe(true)
      expect((await call('design_steps', { design })).steps).toEqual(failed.steps)

      const restored = await call('design_reorder_step', { design, step: 2, to: 3 })
      expect(restored.steps.map((s) => s.id)).toEqual(original.steps.map((s) => s.id))
      expect(restored.steps.map((s) => s.state)).toEqual(['done', 'done', 'done'])
      expect(restored.sizeMm).toEqual(original.sizeMm)
      for (const args of [{ step: 0, to: 2 }, { step: base!.id, to: 4 }, { step: 'missing', to: 2 }, { step: 1, to: 1.5 }]) {
        expect((await h.call('slicerx_design_reorder_step', { design, ...args })).isError).toBe(true)
        expect((await call('design_steps', { design })).steps).toEqual(restored.steps)
      }
      // A join cannot run before the only body exists. Neither history nor geometry changes.
      expect((await h.call('slicerx_design_reorder_step', { design, step: base!.id, to: 3 })).isError).toBe(true)
      expect((await call('design_steps', { design })).steps).toEqual(restored.steps)
      expect((await call('design_steps', { design })).sizeMm).toEqual(original.sizeMm)

      const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design })).output
      const opened = data<{ output: { designs: { design: string }[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs[0]!
      expect((await call('design_steps', { design: opened.design })).steps.map((s) => s.id)).toEqual(original.steps.map((s) => s.id))
    } finally { await h.client.close() }
  })
})
