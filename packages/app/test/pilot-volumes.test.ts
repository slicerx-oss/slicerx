// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// region_modifiers on the app's project: a ring modifier around a named hole lands on the object and its copies, the
// feature-only settings land in the object's own settings, both are one undo step, and the slice request carries them.
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { ToolHost } from '@slicerx/pilot'
import { runAppFunction } from '@slicerx/pilot/functions'
import { appProject } from '../src/features/pilot/project'
import { boxMesh } from '../src/plate/mesh-ops'
import { history } from '../src/plate/history'
import { bounds, compose } from '../src/plate/transform'
import { requestVolumes } from '../src/plate/volumes'
import { get, set, type PlateEntry } from '../src/state/store'

const slicer = {
  loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: `h-${name}-${Math.random()}`, hash: name, name, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: 1, triangles: 12 })) }),
}

async function entry(id: string, position: [number, number, number], instanceOf?: string): Promise<PlateEntry> {
  const part = boxMesh(40, 20, 10)
  const handle = await slicer.loadParts(id, [part])
  return { id, name: 'Bracket', handle, parts: [part], colors: ['#bd93f9'], transform: compose({ position, rotation: [0, 0, 0], scale: [1, 1, 1] }), ...(instanceOf ? { instanceOf } : {}) }
}

beforeEach(async () => {
  history()
  set({ plate: [await entry('b', [100, 100, 5]), await entry('b2', [150, 100, 5], 'b')], objectSettings: {}, selection: 'b', selectedIds: ['b'], slice: { status: 'idle' } })
})

describe('region_modifiers on the app project', () => {
  it('rings a hole on the object and its copy, sets the object settings, and undoes in one step', async () => {
    const project = appProject({ slicer } as never)()
    const out = await runAppFunction('region_modifiers', { goals: ['strong_holes', 'flat_tops'], objectId: 'b', apply: true, holes: [{ center: [5, 0, 0], diameter: 4 }] }, { host: { slicer } as unknown as ToolHost, project })
    expect(out.ok).toBe(true)
    const res = out.output as { applied: boolean; volumes: { id: string; what: string }[]; readBack: { objectSettings: Record<string, unknown>; volumes: { id: string; role: string; settings?: Record<string, unknown> }[] } }
    expect(res.applied).toBe(true)
    expect(res.volumes[0]?.what).toBe('cylinder 10 mm across (the 4 mm hole plus a 3 mm ring), 10 mm tall, at [5, 0, 0]: wall_loops 2 -> 4')
    expect(res.readBack.objectSettings).toEqual({ ironing_type: 'top', ironing_speed: 20 })
    expect(res.readBack.volumes).toEqual([{ id: res.volumes[0]?.id, name: 'Hole ring 4 mm', role: 'modifier', settings: { wall_loops: 4 } }])

    // Both copies carry the ring, placed at the hole in bed coordinates, 10 mm across.
    for (const [id, x] of [['b', 105], ['b2', 155]] as const) {
      const e = get().plate.find((p) => p.id === id)!
      const [req] = requestVolumes(e)
      expect(req).toMatchObject({ role: 'modifier', settings: { wall_loops: 4 } })
      const box = bounds([e.volumes![0]!.part], req!.transform!)!
      expect((box.min[0]! + box.max[0]!) / 2).toBeCloseTo(x, 3)
      expect(box.max[0]! - box.min[0]!).toBeCloseTo(10, 1)
    }
    expect(get().objectSettings['b']).toEqual({ ironing_type: 'top', ironing_speed: 20 })

    // One tool call is one undo step: the rings and the settings go together.
    history().undo()
    expect(get().plate.every((p) => !p.volumes?.length)).toBe(true)
    expect(get().objectSettings['b'] ?? {}).toEqual({})
  })
})
