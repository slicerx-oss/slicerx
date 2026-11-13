// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab paints designs with the server's paint tools on its own design host: the same names, versions and
// inputs as paint.preview, paint.apply and paint.regions over MCP. Applying color paint in a filament past the
// project's last adds that filament and says so, as the part makers do.
import type { DesignHost } from '@slicerx/cad-history'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Designs } from '../src/design'
import { bandDepth, paintTools } from '../src/paint'
import { createCardPlans, createPlanRegistry, NO_ENGINE_HOST, tabToolset, withNewFilaments, type FilamentList, type TabFilament } from '../src/toolset'

const PAINT = ['paint.preview', 'paint.apply', 'paint.regions']
const shape = (t: PilotTool<never>) => Object.keys((t.input as unknown as z.ZodObject).shape)

/** A project with `n` filaments, the defaults PLA in gray. */
function project(n = 1): FilamentList {
  const set: Record<number, TabFilament> = {}
  const out: FilamentList = {
    list: () => Array.from({ length: Math.max(n, ...Object.keys(set).map(Number)) }, (_, i) => set[i + 1] ?? { slot: i + 1, type: 'PLA', color: '#808080' }),
    add: (slot, patch) => void (set[slot] = { slot, type: patch.type ?? 'PLA', color: patch.color ?? '#808080' }),
    set: (slot, patch) => void (set[slot] = { ...out.list()[slot - 1]!, ...patch }),
  }
  return out
}

const run = (t: PilotTool<never>, args: Record<string, unknown>) => t.run(t.input.parse(args) as never, {} as never)

describe('the tab paint tools', () => {
  it('are the server paint tools, by name, version and input', () => {
    const server = paintTools(new Designs({ engine: async () => ({}), policy: {} as never }))
    const tab = tabToolset(NO_ENGINE_HOST as DesignHost, createCardPlans(createPlanRegistry()), { filaments: project() }).filter((t) => PAINT.includes(t.name))
    expect(tab.map((t) => t.name)).toEqual(PAINT)
    expect(tab.map((t) => [t.name, t.version, t.permission, shape(t)])).toEqual(server.map((t) => [t.name, t.version, t.permission, shape(t)]))
    // the same targets in words: the part, faces by direction, a height band, a seed and one state for another; and the feature the apply tags
    expect(shape(tab[0]!)).toEqual(['design', 'layer', 'state', 'target', 'part', 'max_depth', 'view', 'size', 'image', 'feature', 'whole'])
  })

  it('applying color paint in a filament past the last adds it and says so', async () => {
    const p = project(2)
    let seq = 0
    const preview = defineTool({ name: 'paint.preview', version: '1.1.0', source: 'command', permission: 'read', description: 'test', input: z.object({ layer: z.string().default('color'), state: z.number() }), async run() {
      return { summary: 'Preview', output: { preview: `p${++seq}` } }
    } }) as PilotTool<never>
    const apply = defineTool({ name: 'paint.apply', version: '1.1.0', source: 'command', permission: 'slice', description: 'test', input: z.object({ preview: z.string() }), async run() {
      return { summary: 'Applied Paint below 8 mm filament 4 as step 2', output: { step: { index: 2 } } }
    } }) as PilotTool<never>
    const [pv, ap] = withNewFilaments([preview, apply], p)

    // a preview changes nothing, the filaments included
    expect((await run(pv!, { state: 4 })).output).toEqual({ preview: 'p1' })
    expect(p.list()).toHaveLength(2)
    const r = await run(ap!, { preview: 'p1' })
    expect(r.summary).toBe('Applied Paint below 8 mm filament 4 as step 2. The project had 2 filaments, so filaments 3 (PLA #808080), 4 (PLA #808080) were added with the default color. Set the color with project.set_filament.')
    expect(r.output).toMatchObject({ filamentsAdded: [{ slot: 3 }, { slot: 4 }] })
    expect(p.list()).toHaveLength(4)

    // a filament the project has, seam paint and clearing paint add nothing
    await run(pv!, { state: 2 })
    expect((await run(ap!, { preview: 'p2' })).summary).not.toContain('added')
    await run(pv!, { layer: 'seam', state: 6 })
    expect((await run(ap!, { preview: 'p3' })).summary).not.toContain('added')
    await run(pv!, { state: 0 })
    expect((await run(ap!, { preview: 'p4' })).summary).not.toContain('added')
    expect(p.list()).toHaveLength(4)
  })

  it('splits a height band deep enough that its edge lands on its height', () => {
    const side = (h: number) => ({ name: 'Side', slot: 1, positions: [0, 0, 0, 200, 0, 0, 0, 0, h], indices: [0, 1, 2] })
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    // a 14 mm tall side: 9 levels put the edge within 14 / 512 mm, where 6 left it 0.22 mm off, a whole layer
    expect(bandDepth([side(14)], id)).toBe(9)
    expect(14 / 2 ** bandDepth([side(14)], id)).toBeLessThan(0.04)
    // the engine's limit holds for a very tall face
    expect(bandDepth([side(300)], id)).toBe(10)
    // small triangles keep the depth there was; a scale in the transform counts
    expect(bandDepth([side(1)], id)).toBe(6)
    expect(bandDepth([side(1)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1])).toBe(7)
  })
})
