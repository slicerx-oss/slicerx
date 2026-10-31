// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'
import { runSlice, sliceInput, summaryShape, type SliceArgs } from './slice'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'estimate_file',
    title: 'Estimate print time and filament',
    version: '1.2.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description: 'Same inputs as slicerx_slice_file without output and preview, and writes no G-code. Returns print time, filament grams and length in total and per filament slot, and layer count. An argument it does not take is ignored and named in an ignored_arguments warning; pick the printer, process and filament with profiles.',
    // Loose for now: an argument the tool does not take is ignored with a warning (ignored_arguments), not refused.
    input: z.object(sliceInput).loose(),
    outputShape: summaryShape,
    hints: { openWorld: true },
    run: (args, ctx) => runSlice(d, args as SliceArgs, false, (m, f) => ctx.progress(m, f)),
  })
