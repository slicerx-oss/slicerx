// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { ToolInputError } from '../models'
import { explainSetting, findSettings } from '../settings'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'explain_setting',
    title: 'Explain a setting',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'settings',
    ungated: true,
    description: 'Explain one OrcaSlicer setting: label, a plain summary, help text, unit, default, limits, what raising or lowering it does, when it has no effect, and the first slicing stage it invalidates. Use slicerx_find_settings if you do not know the key.',
    input: z.object({ key: z.string().min(1).describe('OrcaSlicer key, such as "sparse_infill_density" or "elefant_foot_compensation"') }),
    async run(args) {
      const info = explainSetting(d.store, args.key.trim())
      if (info) return { summary: args.key.trim(), structured: info as unknown as Record<string, unknown> }
      const near = findSettings(d.store, args.key.replace(/_/g, ' ')).slice(0, 5)
      throw new ToolInputError(`Unknown setting "${args.key}".${near.length ? ` Closest keys: ${near.map((m) => `${m.key} (${m.label})`).join(', ')}.` : ''}`, 'invalid_settings')
    },
  })
