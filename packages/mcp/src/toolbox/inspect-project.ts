// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { resolveModel, ToolInputError } from '../models'
import { readProjectFile } from '../projectfile'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'inspect_project',
    title: 'Inspect a 3MF project',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description:
      'Read a 3MF or .sx3mf project without slicing it: its plates (with names and object counts), the printer, process and filament presets it was saved with, its filament slots (type and color) and whether it carries print settings. Use the plate numbers with slicerx_slice_file and project_settings: true to slice it as it was set up. Open a locked project (.sxlock) with slicerx_sxlock_open first.',
    input: z.object({ file: z.string().min(1).describe('Absolute path or http(s) URL of a .3mf or .sx3mf file') }),
    hints: { openWorld: true },
    async run(args) {
      const path = await resolveModel(d.policy, args.file)
      if (!['.3mf', '.sx3mf'].includes(extname(path).toLowerCase())) throw new ToolInputError(`${basename(path)} is not a 3MF or .sx3mf project`, 'unsupported_format')
      const { summary } = readProjectFile(path)
      const text = [
        `${basename(path)}: ${summary.plates.length} plate${summary.plates.length === 1 ? '' : 's'}${summary.has_settings ? '' : ', no print settings (a plain 3MF)'}`,
        ...summary.plates.map((p) => `Plate ${p.index}${p.name ? ` "${p.name}"` : ''}: ${p.objects} object${p.objects === 1 ? '' : 's'}`),
        ...(summary.presets.printer ? [`Printer preset: ${summary.presets.printer}`] : []),
        ...(summary.presets.process ? [`Process preset: ${summary.presets.process}`] : []),
        ...summary.filaments.map((f) => `Slot ${f.slot}: ${[f.type, f.color, f.preset].filter(Boolean).join(', ')}`),
      ]
      return { summary: text[0] ?? basename(path), structured: summary as unknown as Record<string, unknown>, text: text.join('\n') }
    },
  })
