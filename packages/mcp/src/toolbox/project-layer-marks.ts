// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { READ_ONLY } from '@slicerx/pilot'
import { basename } from 'node:path'
import { z } from 'zod'
import { KIND_LABEL, markOut, plateInput, projectInput, projectPath, readPlateMarks } from '../layer-marks-file'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'project_layer_marks',
    title: 'List layer marks in a project',
    version: '1.0.0',
    source: 'command',
    permission: 'read', hints: READ_ONLY,
    toolset: 'core',
    ungated: true,
    description:
      "List the pauses, color changes, tool changes and custom G-code a 3MF project sets at layers on one plate (Metadata/custom_gcode_per_layer.xml, the marks of the app's Preview layer slider), by height. Each mark has z_mm (the top of the layer it goes in: the first layer whose top reaches it), kind (pause, color_change, tool_change or custom), gcode for a custom mark, slot (the filament a color change goes to or a tool change prints in), skipped (why a tool change saved for a plate of several filaments is kept but not applied) and refused (why a custom text is refused; the app leaves that mark out when it opens the project). Change them with slicerx_project_layer_mark_add and slicerx_project_layer_mark_remove; slicerx_slice_file slices them.",
    input: z.object({ project: projectInput, plate: plateInput }),
    async run(args) {
      const path = projectPath(d.policy, args.project)
      const { plates, marks } = readPlateMarks(path, args.plate)
      const out = marks.map(markOut)
      const lines = [
        `${basename(path)} plate ${args.plate}: ${out.length ? `${out.length} mark${out.length === 1 ? '' : 's'}` : 'no marks'}`,
        ...out.map((m) => `${m.z_mm} mm: ${KIND_LABEL[m.kind]}${m.slot ? ` (filament ${m.slot})` : ''}${m.gcode !== undefined ? `: ${m.gcode.replace(/\n/g, ' / ')}` : ''}${m.skipped ? ` (not applied: ${m.skipped})` : ''}${m.refused ? ` (refused: ${m.refused})` : ''}`),
      ]
      return { summary: lines[0]!, structured: { project: path, plate: args.plate, plates, marks: out }, text: lines.join('\n') }
    },
  })
