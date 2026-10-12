// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { ToolInputError } from '../models'
import { planSettings } from '../settings'
import { serverTool, type ServerToolDeps } from './deps'
import { settingValue } from './slice'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'plan_settings',
    title: 'Plan settings',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'settings',
    ungated: true,
    description:
      'Work out which OrcaSlicer settings to change for a filament, printer, nozzle and print intent. Returns each changed key with before, after and a reason (detail "full" adds the knowledge base sources), plus any validation issues and a config_patch you can pass as overrides to slicerx_slice_file or to slicerx_project_set_overrides. Nothing is saved.',
    input: z.object({
      filament: z.string().optional().describe('Target filament id or name, such as "petg", "PA-CF" or "TPU 95A"'),
      printer: z.string().optional().describe('Target printer id or name, such as "bambu_x1c" or "Prusa MK4S"'),
      nozzle_diameter: z.number().min(0.1).max(2).optional().describe('Target nozzle in mm, such as 0.6'),
      intent: z.string().max(200).optional().describe('draft, standard, fine or strong, or a short phrase such as "strong functional bracket"'),
      from_filament: z.string().optional().describe('Filament currently loaded, to show before values against it'),
      from_printer: z.string().optional().describe('Only when switching printers: the printer the current settings are for. Omit it when the printer stays the same'),
      current: z.record(z.string(), settingValue).optional().describe('Current settings, if the client has them'),
      detail: z.enum(['summary', 'full']).default('summary').describe('summary: each change with its reason; full: also the sources behind each reason'),
    }),
    async run(args) {
      if (!args.filament && !args.printer && args.nozzle_diameter === undefined && !args.intent) throw new ToolInputError('Pass at least one of filament, printer, nozzle_diameter or intent.')
      const plan = planSettings(d.store, {
        ...(args.filament !== undefined ? { filament: args.filament } : {}),
        ...(args.printer !== undefined ? { printer: args.printer } : {}),
        ...(args.nozzle_diameter !== undefined ? { nozzleDiameter: args.nozzle_diameter } : {}),
        ...(args.intent !== undefined ? { intent: args.intent } : {}),
        ...(args.from_filament !== undefined ? { fromFilament: args.from_filament } : {}),
        ...(args.from_printer !== undefined ? { fromPrinter: args.from_printer } : {}),
        ...(args.current !== undefined ? { current: args.current } : {}),
      })
      const out = args.detail === 'full' ? plan : { ...plan, changes: plan.changes.map(({ sources: _s, ...c }) => c), sources_omitted: true }
      return { summary: 'Planned settings', structured: out as unknown as Record<string, unknown> }
    },
  })
