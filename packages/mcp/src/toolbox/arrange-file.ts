// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'
import { arrangedShape, arrangeInput, runSlice, type SliceArgs } from './slice'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'arrange_file',
    title: 'Arrange the parts of a plate',
    version: '1.2.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description:
      "Pack the distinct parts of one plate of a project or model file on the printer's bed, without slicing. The engine's arrange keeps the layout clear of the printer's keep-out zones (bed_exclude_area, and the nozzle wrap check corner of the A1 family), the extruder clearance radius apart plus each part's brim, skirt and support reach when the plate prints by object (parts taller than the gantry rod in lanes of their own when the plate check asks for them), and spacing_mm apart by layer, with room for the prime tower when the plate prints in two filaments or more. Parts keep their rotation and scale and may turn about Z (rotate, in step_deg steps); effort sets how long the search runs, keep names parts that stay where they are while the others are packed round them, and new_plates lays the parts with no room out on new plates in the same call (plates). Same inputs as slicerx_estimate_file without placement and plate_type. Returns each part's new place (center_mm, turn_deg, transform, bed mm), the parts with no room in not_fit (never overlapped; fits is false then), and printing by object heimdall's plate check of the layout. The same plate always gives the same layout, so slicerx_slice_file with placement \"arrange\" slices exactly this one. sx engine only. Changes no file.",
    // Loose for now: an argument the tool does not take is ignored with a warning (ignored_arguments), not refused.
    input: z.object(arrangeInput).loose(),
    outputShape: { engine: z.literal('sx'), model: z.object({ name: z.string() }), plate: z.number().optional(), ...arrangedShape, applied: z.array(z.string()), warnings: z.array(z.string()) },
    hints: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
    run: (args, ctx) => runSlice(d, args as SliceArgs, false, (m, f) => ctx.progress(m, f), Object.keys(arrangeInput), true),
  })
