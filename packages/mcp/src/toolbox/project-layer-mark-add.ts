// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { basename } from 'node:path'
import { z } from 'zod'
import { addPlateMark, ADDABLE_KINDS, KIND_LABEL, markOut, newMark, plateInput, projectInput, projectPath } from '../layer-marks-file'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'project_layer_mark_add',
    title: 'Add a layer mark to a project',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    toolset: 'core',
    description:
      "Add a pause, a color change or custom G-code at a layer to one plate of a 3MF project, as the app's Preview layer slider does, and save it in the file (Metadata/custom_gcode_per_layer.xml), so the project opens in the app and slices with it. z_mm is the top of the layer (the mark goes in the first layer whose top reaches it, kept to 0.1 micron); a mark already at that height is replaced, since a layer holds one. A color change stops the print with the printer's pause G-code for a filament swap by hand; slot names the filament it goes to. Custom G-code always asks the user first, even when the policy allows slicing, and text that changes the printer's memory or configuration, turns the motors off, stops or updates the printer, or heats past 350 C (nozzle) or 130 C (bed) is refused, as in the app; the slice checks it again as imported text. A file with sliced G-code in it is refused. Answers with the mark, any mark it replaced and the plate's marks read back from the saved file.",
    input: z.object({
      project: projectInput,
      plate: plateInput,
      z_mm: z.number().gt(0).max(10000).describe('Height of the layer top the mark goes at, mm'),
      kind: z.enum(ADDABLE_KINDS).describe('pause, color_change or custom'),
      gcode: z.string().max(4000).optional().describe('The G-code to insert at the start of the layer, for custom only (under 2000 characters once trimmed)'),
      slot: z.number().int().min(1).max(64).optional().describe('For a color change: the filament (1-based) it goes to. A note saved with the project; the G-code is the same pause.'),
    }),
    hints: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async mustAsk(i) {
      // Text the app refuses is refused before anyone is asked.
      newMark({ z: i.z_mm, kind: i.kind, ...(i.gcode !== undefined ? { gcode: i.gcode } : {}), ...(i.slot !== undefined ? { slot: i.slot } : {}) })
      return i.kind === 'custom' ? ['Custom G-code at a layer always asks the user first.'] : []
    },
    async approval(i) {
      const where = `${i.z_mm} mm on plate ${i.plate} of ${basename(i.project)}`
      return {
        title: `Add ${KIND_LABEL[i.kind]} at ${where}?`,
        lines: i.kind === 'custom' ? ['Inserts this G-code at the start of that layer when the project is sliced:', ...(i.gcode ?? '').trim().split('\n').slice(0, 12)] : [`Saves a ${KIND_LABEL[i.kind]} in the project${i.slot ? ` (filament ${i.slot})` : ''}.`],
        actions: [],
      }
    },
    async run(i, ctx) {
      // The gate grants a token for every call it lets through; custom text never goes in without one.
      if (i.kind === 'custom' && !ctx.token) return { ok: false, summary: "Custom G-code needs the user's approval." }
      const path = projectPath(d.policy, i.project)
      const r = addPlateMark(path, i.plate, { z: i.z_mm, kind: i.kind, ...(i.gcode !== undefined ? { gcode: i.gcode } : {}), ...(i.slot !== undefined ? { slot: i.slot } : {}) })
      const mark = markOut(r.mark)
      return {
        summary: `Added ${KIND_LABEL[mark.kind]} at ${mark.z_mm} mm on plate ${i.plate}${r.replaced ? ` in place of a ${KIND_LABEL[r.replaced.kind]}` : ''}; ${r.marks.length} mark${r.marks.length === 1 ? '' : 's'} on the plate`,
        output: { project: path, plate: i.plate, mark, ...(r.replaced ? { replaced: markOut(r.replaced) } : {}), marks: r.marks.map(markOut) },
      }
    },
  })
