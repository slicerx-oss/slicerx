// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { findSettings } from '../settings'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'find_settings',
    title: 'Find settings',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'settings',
    ungated: true,
    description: 'Search OrcaSlicer settings by words in the key, label or help text, such as "seam", "first layer speed" or "support interface".',
    input: z.object({
      query: z.string().min(1).max(100),
      section: z.enum(['process', 'filament', 'printer']).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    async run(args) {
      const matches = findSettings(d.store, args.query, args.section ? { section: args.section } : {})
      return { summary: `${matches.length} settings`, structured: { total: matches.length, settings: matches.slice(0, args.limit) } }
    },
  })
