// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'list_profiles',
    title: 'List profiles',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'settings',
    ungated: true,
    description:
      "List printer, filament and process profiles. Ids look like printer:bambu_x1c, filament:petg, intent:strong (Easy goals) machine:<model id> (SlicerX printer profiles, such as machine:bambu-x1-carbon), process:slicerx-default (a fresh SlicerX plate: Standard with sleipnir and aegis walls, used when a slice names no process), process:<tier> (Draft, Standard, Fine, Extra fine and Strong presets, such as process:standard) and stock-filament:<vendor>/<preset> (the makers' own filament presets, such as stock-filament:BBL/Bambu PLA Basic @BBL A1). Filter by section, source, vendor or a text query; paginate with limit and offset.",
    input: z.object({
      section: z.enum(['printer', 'filament', 'process']).optional(),
      source: z.enum(['slicerx', 'knowledge', 'intent', 'stock']).optional().describe("slicerx: SlicerX printer profiles and process presets; knowledge: material and printer entries of the knowledge base; intent: Easy goals; stock: the makers' filament presets"),
      vendor: z.string().optional().describe('Vendor name, case-insensitive, such as "Bambu Lab" or "Prusa"'),
      query: z.string().optional().describe('Substring of the profile name or id'),
      limit: z.number().int().min(1).max(200).default(20),
      offset: z.number().int().min(0).default(0),
    }),
    async run(args) {
      const q = args.query?.toLowerCase()
      const all = d.profiles
        .list()
        .filter((p) => !args.section || p.section === args.section)
        .filter((p) => !args.source || p.source === args.source)
        .filter((p) => !args.vendor || (p.vendor ?? '').toLowerCase().includes(args.vendor.toLowerCase()))
        .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      const page = all.slice(args.offset, args.offset + args.limit)
      const next = args.offset + page.length
      return { summary: `${page.length} of ${all.length} profiles`, structured: { total: all.length, count: page.length, offset: args.offset, profiles: page, has_more: next < all.length, ...(next < all.length ? { next_offset: next } : {}) } }
    },
  })
