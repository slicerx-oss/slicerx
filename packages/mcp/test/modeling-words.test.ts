// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the modeling tools tell a client about filaments and openings, word for word: a new part's slot past the
// project's last filament adds one, so it is only for a color the person asked for; and an opening is a cut, not a
// built solid. A local model's form keeps today's shorter words (its tool rows have no room for these).
import { expect, it } from 'vitest'
import { z } from 'zod'
import { cadTools } from '../src/cad'
import { modelingTools } from '../src/modeling-tools'

const unused = (): never => {
  throw new Error('not used')
}
const tools = [
  ...modelingTools({ files: { call: async () => ({}), mesh: async () => ({ stlPath: '' }) } }),
  ...cadTools({ files: { engine: false, call: unused, path: unused, stl: unused } } as never),
]
const tool = (name: string) => tools.find((t) => t.name === name)!
const slotOf = (input: unknown): string | undefined => (z.toJSONSchema(input as z.ZodType, { unrepresentable: 'any' }) as { properties: Record<string, { description?: string }> }).properties['slot']!.description

it('says a slot past the last filament adds one, only for a color the person asked for, and keeps the short slot text locally', () => {
  expect(slotOf(tool('geom.build').input)).toBe("With a design: the new part's filament slot, from 1 (default 1). A slot past the project's last filament adds a filament: give one only for a color the person asked for")
  expect(slotOf(tool('geom.build').localInput)).toBe('With a design: the filament slot of the new part, from 1')
  for (const name of ['geom.extrude', 'geom.revolve', 'geom.loft', 'geom.sweep']) {
    expect(slotOf(tool(name).input), name).toBe("Filament of a new part on a design, from 1. One past the project's last filament adds a filament: only for a color the person asked for")
    expect(slotOf(tool(name).localInput), name).toBe('Filament of a new part on a design, from 1')
  }
})

it('says an opening is a cut, in the cloud text only', () => {
  const opening = 'optionally cutting holes with convex cutters. Never for an opening in a part (a window, vent or slot): that is a cut, with geom.extrude or geom.hole.'
  expect(tool('geom.build').description).toContain(opening)
  expect(tool('geom.build').localDescription).not.toContain('Never for an opening')
})
