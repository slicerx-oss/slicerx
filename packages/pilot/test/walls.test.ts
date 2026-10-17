// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshPart, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { evalGeom } from '../evals/geom'
import { createEvalEnv, createEvalSlicer, evalKb } from '../evals/harness'
import { createMemoryProject } from '../src/memory-project'
import { createScriptedClient } from '../src/provider/scripted'
import type { PilotTool, ToolContext, ToolHost } from '../src/tool'
import { flatFaces, partTriangles, type FaceSummary, type V3 } from '../skills/geom_common/faces'
import { meshVolume, partFromGeom, toGeomMesh } from '../skills/geom_common/index'
import { primMesh, primitives } from '../skills/text_to_part/solids'
import { createWalls } from '../skills/walls/index'
import { findTarget, planWalls } from '../skills/walls/plan'

const geom = evalGeom()
const MACHINE: PilotMachine = { printer: 'bambu_a1', material: 'pla', nozzle: 0.4 }
const GEOM_TIMEOUT_MS = 30_000

const face = (at: V3, normal: V3, areaMm2 = 100): FaceSummary => ({ triangle: 0, at, normal, areaMm2, center: at })
/** The flat faces of a 100 x 60 x 10 mm tray with 2 mm walls and floor, open on top. */
const TRAY: FaceSummary[] = [
  face([50, 30, 0], [0, 0, -1], 6000),
  face([50, 30, 2], [0, 0, 1], 5376),
  face([50, 30, 10], [0, 0, 1], 608),
  face([0, 30, 5], [-1, 0, 0], 600),
  face([100, 30, 5], [1, 0, 0], 600),
  face([2, 30, 6], [1, 0, 0], 448),
  face([98, 30, 6], [-1, 0, 0], 448),
  face([50, 0, 5], [0, -1, 0], 1000),
  face([50, 60, 5], [0, 1, 0], 1000),
  face([50, 2, 6], [0, 1, 0], 768),
  face([50, 58, 6], [0, -1, 0], 768),
]
const BOUNDS = { min: [0, 0, 0] as V3, max: [100, 60, 10] as V3 }

describe('wall plan', () => {
  it('finds the four inner walls and their thickness, and moves each by the difference', () => {
    const p = planWalls(TRAY, BOUNDS, { which: 'walls', wallMm: 3 })
    if ('error' in p) throw new Error(p.error)
    expect(p.targets.map((t) => [t.kind, t.thicknessMm, t.deltaMm])).toEqual(Array(4).fill(['wall', 2, 1]))
  })

  it('moves the floor only when asked, and last', () => {
    const p = planWalls(TRAY, BOUNDS, { which: 'both', byMm: 0.5 })
    if ('error' in p) throw new Error(p.error)
    expect(p.targets.map((t) => t.kind)).toEqual(['wall', 'wall', 'wall', 'wall', 'floor'])
    const f = planWalls(TRAY, BOUNDS, { which: 'floor', wallMm: 1 })
    if ('error' in f) throw new Error(f.error)
    expect(f.targets).toMatchObject([{ kind: 'floor', thicknessMm: 2, deltaMm: -1 }])
  })

  it('refuses a wall thinner than 0.4 mm, walls that fill the inside, and a part with no walls', () => {
    expect(planWalls(TRAY, BOUNDS, { which: 'walls', byMm: -1.8 })).toMatchObject({ error: /thinnest is 0.4 mm/ })
    expect(planWalls(TRAY, BOUNDS, { which: 'walls', byMm: 30 })).toMatchObject({ error: /room inside/ })
    const cube = [face([0, 5, 5], [-1, 0, 0]), face([10, 5, 5], [1, 0, 0]), face([5, 5, 0], [0, 0, -1]), face([5, 5, 10], [0, 0, 1])]
    expect(planWalls(cube, { min: [0, 0, 0], max: [10, 10, 10] }, { which: 'walls', wallMm: 2 })).toMatchObject({ error: /no flat walls/ })
    expect(planWalls(TRAY, BOUNDS, { which: 'walls', wallMm: 2 })).toMatchObject({ error: /already 2 mm/ })
  })

  it('finds a target again by its plane after other faces moved', () => {
    const p = planWalls(TRAY, BOUNDS, { which: 'walls', wallMm: 3 })
    if ('error' in p) throw new Error(p.error)
    const t = p.targets[0]!
    const split = [face(t.at, t.normal, 10), face([t.at[0], t.at[1] + 1, t.at[2]], t.normal, 400), ...TRAY.filter((f) => f !== TRAY.find((x) => x.at === t.at))]
    expect(findTarget(split, t)?.areaMm2).toBe(400)
  })
})

/** An open-top tray as one closed body: the outer box less an inner box that runs out through the top. */
async function tray(x: number, y: number, h: number, t: number): Promise<MeshPart> {
  const g = geom!
  const box = async (min: number[], max: number[]) => ((await g.run('build', { solids: [{ type: 'box', min, max }] })) as Record<string, unknown>)['mesh']
  const out = (await g.run('boolean', { op: 'difference', a: [await box([0, 0, 0], [x, y, h])], b: [await box([t, t, t], [x - t, y - t, h + 1])] })) as Record<string, unknown>
  return partFromGeom(out['mesh'], 'body', 1)!
}

function toolsWith(parts: MeshPart[]) {
  const kb = evalKb()
  const project = createMemoryProject('t', MACHINE, [{ id: 'case', name: 'Case', bboxMm: [100, 60, 10], mesh: async () => parts }], kb)
  const env = createEvalEnv({ client: createScriptedClient([]), machine: MACHINE, objects: [] })
  const host: ToolHost = { printers: env.sim, slicer: createEvalSlicer(() => project), ...(geom ? { geom } : {}) }
  const ctx: ToolContext = { host, sessionId: 's', callId: 'c', signal: new AbortController().signal, context: { machine: MACHINE }, today: '2026-10-14', project, kb, progress: () => undefined }
  const t = createWalls() as unknown as PilotTool<Record<string, unknown>>
  return { project, run: (input: Record<string, unknown>) => t.run(t.input.parse(input), ctx) }
}

const inner = (p: MeshPart): number[] => {
  const faces = flatFaces(partTriangles(p))
  const xs = faces.filter((f) => Math.abs(f.normal[0]) > 0.999 && f.at[0] > 0.01 && f.at[0] < 99.99).map((f) => f.at[0])
  return [Math.min(...xs), Math.max(...xs)]
}

describe.skipIf(!geom)('walls through the geometry engine', () => {
  it(
    'thickens a tray from 2 to 3 mm in place: same outside, inside 2 mm narrower each way, watertight',
    async () => {
      const t = toolsWith([await tray(100, 60, 10, 2)])
      const out = await t.run({ wallMm: 3 })
      expect(out.ok).not.toBe(false)
      expect(out.output).toMatchObject({ replaced: true, after: { sizeMm: [100, 60, 10], watertight: true } })
      const part = (await t.project.objects()[0]!.mesh!())[0]!
      expect(inner(part)).toEqual([3, 97])
      // 100 x 60 x 10 less a 94 x 54 x 8 opening, from 100 x 60 x 10 less 96 x 56 x 8
      expect(meshVolume([part])).toBeCloseTo(60000 - 94 * 54 * 8, 0)
      expect(t.project.objects()).toHaveLength(1)
    },
    GEOM_TIMEOUT_MS,
  )

  it(
    'thins the walls and the floor by 0.5 mm',
    async () => {
      const t = toolsWith([await tray(100, 60, 10, 2)])
      await t.run({ byMm: -0.5, which: 'both' })
      const part = (await t.project.objects()[0]!.mesh!())[0]!
      expect(inner(part)).toEqual([1.5, 98.5])
      expect(meshVolume([part])).toBeCloseTo(60000 - 97 * 57 * 8.5, 0)
      expect(toGeomMesh([part]).indices.length).toBeGreaterThan(0)
    },
    GEOM_TIMEOUT_MS,
  )

  it(
    'leaves a part without walls as it is and says why',
    async () => {
      const cube = primMesh(primitives([{ type: 'box', sizeMm: [20, 20, 20] }]), 'cube')
      const t = toolsWith([cube])
      const out = await t.run({ wallMm: 2 })
      expect(out.ok).toBe(false)
      expect(out.summary).toMatch(/unchanged: no flat walls/)
    },
    GEOM_TIMEOUT_MS,
  )
})
