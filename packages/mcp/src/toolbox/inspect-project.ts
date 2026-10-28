// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { resolveModel, ToolInputError } from '../models'
import { importReportLines, readProjectFile } from '../projectfile'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'inspect_project',
    title: 'Inspect a 3MF project',
    version: '1.1.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description:
      'Read a 3MF or .sx3mf project without slicing it: its plates (with names and object counts), the printer, process and filament presets it was saved with, its filament slots (type and color), its support settings (`support`: enable_support, support_* and tree_support_* as the file sets them), whether it carries print settings, and with settings `project_config`: the settings a slice with project_settings: true and no machine: profile takes from the file (its own values, the engine choices it did not change, and the reading of keys it lacks by the app that wrote it, such as the rib prime tower for a Bambu Studio project), as one object to pass as the config of a slice request. Use the plate numbers with slicerx_slice_file and project_settings: true to slice it as it was set up. Open a locked project (.sxlock) with slicerx_sxlock_open first.',
    input: z.object({ file: z.string().min(1).describe('Absolute path or http(s) URL of a .3mf or .sx3mf file') }),
    hints: { openWorld: true },
    async run(args) {
      const path = await resolveModel(d.policy, args.file)
      if (!['.3mf', '.sx3mf'].includes(extname(path).toLowerCase())) throw new ToolInputError(`${basename(path)} is not a 3MF or .sx3mf project`, 'unsupported_format')
      const { summary, config } = readProjectFile(path)
      const text = [
        `${basename(path)}: ${summary.plates.length} plate${summary.plates.length === 1 ? '' : 's'}${summary.has_settings || summary.import_report.skipped ? '' : ', no print settings (a plain 3MF)'}`,
        ...summary.plates.map((p) => `Plate ${p.index}${p.name ? ` "${p.name}"` : ''}: ${p.objects} object${p.objects === 1 ? '' : 's'}`),
        ...(summary.presets.printer ? [`Printer preset: ${summary.presets.printer}`] : []),
        ...(summary.presets.process ? [`Process preset: ${summary.presets.process}`] : []),
        ...summary.filaments.map((f) => `Slot ${f.slot}: ${[f.type, f.color, f.preset].filter(Boolean).join(', ')}`),
        ...(Object.keys(summary.support).length > 0
          ? [`Support: ${Object.entries(summary.support).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(';') : String(v)}`).join(', ')}`]
          : []),
        ...(summary.import_report.source ? [`Written by ${summary.import_report.source}`] : []),
        ...importReportLines(summary.import_report).map((l) => `Settings: ${l}`),
      ]
      // The settings slicerx_slice_file takes from the project with project_settings: true and no machine: profile, as
      // one object a request client can pass as its config (`sx project-settings <file.3mf>` prints the engine's own
      // reading of them).
      const structured = { ...summary, ...(summary.has_settings ? { project_config: config } : {}) }
      return { summary: text[0] ?? basename(path), structured: structured as unknown as Record<string, unknown>, text: text.join('\n') }
    },
  })
