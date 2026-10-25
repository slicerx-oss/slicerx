// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { ToolInputError } from '../models'
import { findSettings } from '../settings'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'list_setting_defaults',
    title: 'List setting defaults',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'settings',
    ungated: true,
    description:
      'List the default value of every setting, or of one section or the keys given, each with its scope (process, printer or filament), from the same data as slicerx_explain_setting and equal to defaults.json in the integrator kit. ' +
      'Only process defaults are what the engine slices with when a config leaves a key out. Printer and filament defaults are the app\'s starting preset, not the engine\'s own values. ' +
      'Printer presets, filament presets and a project\'s own values override all of these. A key with no default is listed in no_default: the engine works it out.',
    input: z.object({
      section: z.enum(['process', 'printer', 'filament']).optional().describe('Only this scope'),
      keys: z.array(z.string().min(1)).min(1).max(1000).optional().describe('Only these setting keys, such as ["skirt_loops", "nozzle_diameter"]'),
    }),
    async run(args) {
      const wanted = args.keys ? new Set(args.keys.map((k) => k.trim())) : undefined
      if (wanted) {
        const unknown = [...wanted].filter((k) => !d.store.setting(k))
        if (unknown.length) {
          const near = findSettings(d.store, unknown[0]!.replace(/_/g, ' ')).slice(0, 5)
          const names = unknown.map((k) => `"${k}"`).join(', ')
          throw new ToolInputError(`Unknown setting${unknown.length > 1 ? 's' : ''} ${names}.${near.length ? ` Closest keys: ${near.map((m) => `${m.key} (${m.label})`).join(', ')}.` : ''}`, 'invalid_settings')
        }
      }
      const settings: { key: string; scope: string; default: unknown }[] = []
      const noDefault: string[] = []
      for (const def of d.store.settingsSchema()) {
        if (args.section && def.section !== args.section) continue
        if (wanted && !wanted.has(def.key)) continue
        if (def.default === undefined) noDefault.push(def.key)
        else settings.push({ key: def.key, scope: def.section, default: def.default })
      }
      return {
        summary: `${settings.length} defaults${noDefault.length ? `, ${noDefault.length} without one` : ''}`,
        structured: { total: settings.length, settings, no_default: noDefault },
      }
    },
  })
