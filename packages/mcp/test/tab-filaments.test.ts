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

/** A project whose filaments start as `seed`, each changed only through the list. */
function seeded(seed: readonly Omit<TabFilament, 'slot'>[]): FilamentList {
  const all: TabFilament[] = seed.map((f, i) => ({ slot: i + 1, ...f }))
  return {
    list: () => all.map((f) => ({ ...f })),
    add: (slot, patch) => void all.push({ slot, type: patch.type ?? 'PLA', color: patch.color ?? '#808080' }),
    set: (slot, patch) => void Object.assign(all[slot - 1]!, patch),
  }
}

describe('the tab filament tools keep the filaments a project has', () => {
  const spools = [
    { type: 'PLA', color: '#ffffff' },
    { type: 'PLA', color: '#1a1a1f' },
    { type: 'PETG', color: '#3b82f6' },
    { type: 'TPU', color: '#f97316' },
  ]

  it('a color the project already has is not added again: the answer names the filament to use', async () => {
    const p = seeded(spools)
    const [add] = filamentTools(p)
    expect(await run(add!, { type: 'PLA', color: '#1c1c1e' })).toEqual({ ok: false, summary: 'Filament 2 is already PLA #1a1a1f, close to #1c1c1e: paint or print with filament 2. Nothing was added.' })
    // an off-white reads as the white the project has
    expect(await run(add!, { color: '#f2f2ee' })).toMatchObject({ ok: false, summary: expect.stringContaining('paint or print with filament 1') })
    expect(p.list()).toHaveLength(4)
  })

  it('adds only a new color, and the same color in another material is a new filament', async () => {
    const p = seeded(spools)
    const [add] = filamentTools(p)
    expect(await run(add!, { type: 'PLA', color: '#a8261c' })).toMatchObject({ summary: 'Added filament 5: PLA #a8261c' })
    expect(await run(add!, { type: 'PLA', color: '#d9a441' })).toMatchObject({ summary: 'Added filament 6: PLA #d9a441' })
    expect(await run(add!, { type: 'PETG', color: '#1c1c1e' })).toMatchObject({ summary: 'Added filament 7: PETG #1c1c1e' })
    expect(p.list().map((f) => `${f.type} ${f.color}`)).toEqual(['PLA #ffffff', 'PLA #1a1a1f', 'PETG #3b82f6', 'TPU #f97316', 'PLA #a8261c', 'PLA #d9a441', 'PETG #1c1c1e'])
  })

  it("never rewrites a filament's material", async () => {
    const p = seeded(spools)
    const [, set] = filamentTools(p)
    expect(await run(set!, { slot: 3, type: 'PLA', color: '#a8261c' })).toEqual({ ok: false, summary: "Filament 3 stays PETG: a filament's material is not changed. For PLA, add a filament with project.add_filament. Nothing changed." })
    expect(await run(set!, { slot: 4, type: 'pla' })).toMatchObject({ ok: false, summary: expect.stringContaining('Filament 4 stays TPU') })
    expect(p.list().map((f) => f.type)).toEqual(['PLA', 'PLA', 'PETG', 'TPU'])
    // its own material, named again, and a new color are fine
    expect(await run(set!, { slot: 1, type: 'PLA', color: '#f2f2ee' })).toMatchObject({ summary: 'Set filament 1: PLA #f2f2ee' })
  })
})

describe('the tab says a color is already there by how alike the two look', () => {
  /** Filament 1 TPU orange, filament 2 PLA in `color`. */
  const two = (color: string) => seeded([{ type: 'TPU', color: '#f97316' }, { type: 'PLA', color }])

  it.each([
    ['#1a1a1a', '#000000'],
    ['#f2f2ee', '#ffffff'],
    ['#c8a23c', '#d9a441'],
    ['#909090', '#808080'],
    ['#e6e6e6', '#ffffff'],
  ])('refuses PLA %s beside PLA %s, naming filament 2', async (color, has) => {
    const p = two(has)
    const [add] = filamentTools(p)
    expect(await run(add!, { type: 'PLA', color })).toEqual({ ok: false, summary: `Filament 2 is already PLA ${has}, close to ${color}: paint or print with filament 2. Nothing was added.` })
    expect(p.list()).toHaveLength(2)
  })

  it.each([
    ['#d1d3d5', '#ffffff'],
    ['#333333', '#000000'],
    ['#cccccc', '#ffffff'],
    ['#ff8000', '#d9a441'],
    ['#000080', '#0000ff'],
    ['#a82a22', '#c8102e'],
  ])('adds PLA %s beside PLA %s', async (color, has) => {
    const p = two(has)
    const [add] = filamentTools(p)
    expect(await run(add!, { type: 'PLA', color })).toMatchObject({ summary: `Added filament 3: PLA ${color}` })
  })

  it('adds the same color in another material', async () => {
    const p = two('#000000')
    const [add] = filamentTools(p)
    expect(await run(add!, { type: 'PETG', color: '#1a1a1a' })).toMatchObject({ summary: 'Added filament 3: PETG #1a1a1a' })
    expect(await run(add!, { type: 'PETG', color: '#000000' })).toMatchObject({ ok: false, summary: expect.stringContaining('paint or print with filament 3') })
    expect(await run(add!, { type: 'TPU', color: '#000000' })).toMatchObject({ summary: 'Added filament 4: TPU #000000' })
  })
})
