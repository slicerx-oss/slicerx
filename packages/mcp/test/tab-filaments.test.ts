// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab's filament tools on any project that lists its filaments: the same names, inputs and refusals as the
// server's project.add_filament and project.set_filament, with every filament read back; and the part makers given a
// filament past the last adding it and saying so.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FILAMENT_TOOLS, filamentTools, SLOT_TOOLS, withNewFilaments, type FilamentList, type TabFilament } from '../src/toolset'

/** A project with `n` filaments, the defaults PLA in gray, and the slots its parts use. */
function project(n = 1): FilamentList & { used: number } {
  const set: Record<number, TabFilament> = {}
  const out = {
    used: 0,
    list: () => Array.from({ length: Math.max(n, out.used, ...Object.keys(set).map(Number)) }, (_, i) => set[i + 1] ?? { slot: i + 1, type: 'PLA', color: '#808080' }),
    add: (slot: number, patch: { type?: string; color?: string }) => void (set[slot] = { slot, type: patch.type ?? 'PLA', color: patch.color ?? '#808080' }),
    set: (slot: number, patch: { type?: string; color?: string }) => void (set[slot] = { ...out.list()[slot - 1]!, ...patch }),
  }
  return out
}

const run = (t: PilotTool<never>, args: Record<string, unknown>) => t.run(t.input.parse(args) as never, {} as never)

describe('the tab filament tools', () => {
  it('match the server tools by name and input', () => {
    const tools = filamentTools(project())
    expect(tools.map((t) => t.name)).toEqual([...FILAMENT_TOOLS])
    expect(Object.keys((tools[0]!.input as unknown as z.ZodObject).shape)).toEqual(['type', 'color'])
    expect(Object.keys((tools[1]!.input as unknown as z.ZodObject).shape)).toEqual(['slot', 'type', 'color'])
  })

  it('add after the last and set one, reading every filament back', async () => {
    const p = project(2)
    const [add, set] = filamentTools(p)
    expect(await run(add!, { type: 'abs', color: '#00FF00AA' })).toEqual({ summary: 'Added filament 3: ABS #00ff00', output: { filament: { slot: 3, type: 'ABS', color: '#00ff00' }, filaments: p.list() } })
    expect(await run(set!, { slot: 2, color: 'ffffff' })).toMatchObject({ summary: 'Set filament 2: PLA #ffffff' })
    expect(p.list().map((f) => f.color)).toEqual(['#808080', '#ffffff', '#00ff00'])
  })

  it('refuse what the server refuses', async () => {
    const p = project()
    const [add, set] = filamentTools(p)
    expect(await run(set!, { slot: 1 })).toMatchObject({ ok: false, summary: 'Give a type, a color or both.' })
    expect(await run(set!, { slot: 2, type: 'PLA' })).toMatchObject({ ok: false, summary: 'No filament 2: the project has 1. Add one with project.add_filament.' })
    expect(await run(add!, { type: 'Wood' })).toMatchObject({ ok: false, summary: expect.stringContaining('is not a filament type') })
    expect(p.list()).toHaveLength(1)
  })

  it('a part maker given a filament past the last adds it and says so', async () => {
    const p = project()
    const build = defineTool({ name: 'geom.build', version: '1.0.0', source: 'command', permission: 'slice', description: 'test', input: z.object({ slot: z.number().optional() }), async run(i) {
      p.used = Math.max(p.used, i.slot ?? 1)
      return { summary: 'Built: step 1', output: { design: 'd1' } }
    } }) as PilotTool<never>
    const [wrapped] = withNewFilaments([build], p)
    const r = await run(wrapped!, { slot: 3 })
    expect(r.summary).toBe('Built: step 1. The project had 1 filament, so filaments 2 (PLA #808080), 3 (PLA #808080) were added with the default color. Set the color with project.set_filament.')
    expect(r.output).toEqual({ design: 'd1', filamentsAdded: [{ slot: 2, type: 'PLA', color: '#808080' }, { slot: 3, type: 'PLA', color: '#808080' }] })
    expect(await run(wrapped!, { slot: 2 })).toEqual({ summary: 'Built: step 1', output: { design: 'd1' } })
    expect([...SLOT_TOOLS]).toEqual(['geom.build', 'geom.extrude', 'geom.revolve', 'geom.loft', 'geom.sweep', 'geom.emboss', 'design.part_filament'])
  })
})
