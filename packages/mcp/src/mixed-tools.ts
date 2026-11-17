// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mixed filaments of the open project (the app's Mix button on the Slice filament card): two loaded filaments
// printed on alternating layers in a ratio, under a filament number of their own that objects, parts and paint use
// like a loaded one, on every plate. Each tool answers with the project's mixes read back.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { MAX_MIX_RATIO, MIX_LOWEST_ID, MIX_TOP_ID, mixLayerFilament, type MixedFilament } from '@slicerx/settings/mixed'
import { z } from 'zod'
import { MAX_FILAMENTS } from './filaments'
import type { McpProject } from './project'

const filament = z.number().int().min(1).max(MAX_FILAMENTS)
const mixId = z.number().int().min(MIX_LOWEST_ID).max(MIX_TOP_ID).describe('The mix number from slicerx_project_mixed_filaments')
const pair = z.tuple([filament, filament]).refine(([a, b]) => a !== b, 'Pick two different filaments')
const ratio = z.tuple([z.number().int().min(1).max(MAX_MIX_RATIO), z.number().int().min(1).max(MAX_MIX_RATIO)]).describe(`Layers of each filament per cycle, 1 to ${MAX_MIX_RATIO}, such as [2, 1] for two of A then one of B`)
const name = z.string().trim().min(1).max(40)

/** The first cycle of a mix as filament numbers, for the read-back: [1, 1, 2] for 2:1. */
const cycle = (m: MixedFilament): number[] => Array.from({ length: m.ratio[0] + m.ratio[1] }, (_, l) => mixLayerFilament(m, l))

export function mixedFilamentTools(need: () => McpProject): PilotTool<never>[] {
  const read = (p: McpProject) => ({ mixes: p.mixes().map((m) => ({ ...p.describeMix(m), cycle: cycle(m) })) })
  const fail = (e: unknown) => ({ ok: false, summary: e instanceof Error ? e.message : String(e) })

  const list = defineTool({
    name: 'project.mixed_filaments',
    version: '1.0.0',
    source: 'settings',
    permission: 'read',
    description: "List the mixed filaments of the open project (a number means the same mix on every plate): each one's number (what objects, parts and paint use), name, its two loaded filaments, the ratio in layers, the first cycle of filaments layer by layer, and an approximate color (the two colors averaged in linear RGB by the ratio).",
    input: z.object({}),
    async run() {
      const p = need()
      try {
        const out = read(p)
        return { summary: `The project has ${out.mixes.length} mixed ${out.mixes.length === 1 ? 'filament' : 'filaments'}`, output: out }
      } catch (e) {
        return fail(e)
      }
    },
  })

  const add = defineTool({
    name: 'project.add_mixed_filament',
    version: '1.0.0',
    source: 'settings',
    permission: 'slice',
    description: `Add a mixed filament to the open project (the app's Mix button), usable on every plate: two of the project's loaded filaments and a ratio in layers. When slicing, every region on the mix prints each layer in one of the two, the second's layers spread through each cycle (2:1 prints A, A, B), so the colors blend; each switch is an ordinary tool change with its flush. It takes the highest free filament number from 32 down, past the loaded filaments. Assign it with slicerx_project_set_object_filament, or paint with its number. Answers with the project's mixes read back.`,
    input: z.object({ filaments: pair.describe('The two loaded filaments to mix, 1-based'), ratio, name: name.optional().describe('A name; default "Mix of A and B"') }),
    async run(i) {
      const p = need()
      try {
        const m = p.addMix({ name: i.name, components: i.filaments, ratio: i.ratio })
        return { summary: `Added mix ${m.id} "${m.name}": filaments ${m.components.join(' and ')}, ${m.ratio.join(':')}`, output: { mix: p.describeMix(m), ...read(p) } }
      } catch (e) {
        return fail(e)
      }
    },
  })

  const update = defineTool({
    name: 'project.set_mixed_filament',
    version: '1.0.0',
    source: 'settings',
    permission: 'slice',
    description: 'Change a mixed filament of the open project: its two filaments, its ratio, its name, or several. What is not given stays; its number and the parts on it, on every plate, stay. Answers with the project\'s mixes read back.',
    input: z.object({ id: mixId, filaments: pair.optional(), ratio: ratio.optional(), name: name.optional() }),
    async run(i) {
      const p = need()
      if (i.filaments === undefined && i.ratio === undefined && i.name === undefined) return { ok: false, summary: 'Give filaments, a ratio, a name or several.' }
      try {
        const m = p.updateMix(i.id, { name: i.name, components: i.filaments, ratio: i.ratio })
        return { summary: `Mix ${m.id} "${m.name}" is filaments ${m.components.join(' and ')}, ${m.ratio.join(':')}`, output: { mix: p.describeMix(m), ...read(p) } }
      } catch (e) {
        return fail(e)
      }
    },
  })

  const remove = defineTool({
    name: 'project.remove_mixed_filament',
    version: '1.0.0',
    source: 'settings',
    permission: 'slice',
    description: "Delete a mixed filament of the open project. Parts assigned to it, on every plate, go back to its first filament. Answers with the project's mixes read back and how many parts moved.",
    input: z.object({ id: mixId }),
    async run(i) {
      const p = need()
      try {
        const r = p.removeMix(i.id)
        return { summary: `Removed mix ${i.id} "${r.removed.name}"${r.moved ? `; ${r.moved} ${r.moved === 1 ? 'part' : 'parts'} back on filament ${r.removed.components[0]}` : ''}`, output: { moved: r.moved, ...read(p) } }
      } catch (e) {
        return fail(e)
      }
    },
  })

  const assign = defineTool({
    name: 'project.set_object_filament',
    version: '1.0.0',
    source: 'settings',
    permission: 'slice',
    description: "Print an object of the open project with a filament: one of the loaded filaments, or one of the project's mixed filaments by its number (the app's spool click with the object selected). Every part of the object prints with it, since the slice takes one filament per object here. Answers with the object's filaments read back as the slice reads them.",
    input: z.object({
      objectId: z.string().min(1).describe('Object id from slicerx_project_show'),
      filament: z.number().int().min(1).max(MIX_TOP_ID).describe('A loaded filament (1-based) or a mix number'),
    }),
    async run(i) {
      const p = need()
      try {
        p.setObjectFilament(i.objectId, i.filament)
        return { summary: `${i.objectId} prints with filament ${i.filament}`, output: { objectId: i.objectId, filament: i.filament, filaments: p.objectFilaments(i.objectId) } }
      } catch (e) {
        return fail(e)
      }
    },
  })

  return [list, add, update, remove, assign] as PilotTool<never>[]
}
