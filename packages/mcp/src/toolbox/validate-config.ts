// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { validateConfig } from '../settings'
import { serverTool, type ServerToolDeps } from './deps'
import { settingValue } from './slice'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'validate_config',
    title: 'Validate a config',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'settings',
    ungated: true,
    description:
      'Check a full or partial OrcaSlicer config: unknown keys, wrong types, values outside OrcaSlicer limits or the usual range, keys that have no effect, and cross-key problems (layer height against nozzle, fan order, nozzle temperature against the filament). Each issue has a severity and may suggest a fix; nothing is changed.',
    input: z.object({
      config: z.record(z.string(), settingValue).describe('Setting keys to values'),
      nozzle_diameter: z.number().min(0.1).max(2).optional(),
      filament: z.string().optional().describe('Filament id or name for the temperature check, when filament_type is not in the config'),
    }),
    async run(args) {
      const issues = validateConfig(d.store, args.config, {
        ...(args.nozzle_diameter !== undefined ? { nozzleDiameter: args.nozzle_diameter } : {}),
        ...(args.filament !== undefined ? { filament: args.filament } : {}),
      })
      const counts = { error: 0, warning: 0, info: 0 }
      for (const i of issues) counts[i.severity]++
      return { summary: `${counts.error} errors, ${counts.warning} warnings`, structured: { valid: counts.error === 0, counts, issues } }
    },
  })
