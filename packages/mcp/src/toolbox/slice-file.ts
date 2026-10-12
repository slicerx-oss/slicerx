// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'
import { runSlice, sliceFileInput, summaryShape, type SliceArgs } from './slice'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'slice_file',
    title: 'Slice a model file',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description:
      'Slice one model file or one plate of a 3MF or .sx3mf project to G-code with SlicerX, without opening a project. Settings are schema defaults, then the project file\'s own settings (project_settings), then each profile in order, then the user\'s preset files (profile_files), then overrides. Returns the G-code path (and a .gcode.3mf with output "gcode.3mf"), print time, filament grams and length in total and per filament slot, and layer count. Sends progress notifications when the request carries a progress token. Use slicerx_estimate_file when you only need the numbers, and the project tools (slicerx_project_open, slicerx_arrange, slicerx_slice, slicerx_printer_queue) for plates and printers. With the stub engine the result is a rough estimate and the G-code file is not printable.',
    input: z.object(sliceFileInput),
    outputShape: summaryShape,
    hints: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
    run: (args, ctx) => runSlice(d, args as SliceArgs, true, (m, f) => ctx.progress(m, f)),
  })
