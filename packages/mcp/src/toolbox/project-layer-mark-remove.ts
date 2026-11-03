// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { basename } from 'node:path'
import { z } from 'zod'
import { KIND_LABEL, markOut, plateInput, projectInput, projectPath, removePlateMark } from '../layer-marks-file'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'project_layer_mark_remove',
    title: 'Remove a layer mark from a project',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    toolset: 'core',
    description:
      "Remove the pause, color change, tool change or custom G-code at a height from one plate of a 3MF project and save the file, as removing a mark on the app's Preview layer slider does. z_mm is the mark's height as slicerx_project_layer_marks lists it; a height with no mark is refused with not_found and the heights that have one. A file with sliced G-code in it is refused. Answers with the removed mark and the plate's marks read back from the saved file.",
    input: z.object({ project: projectInput, plate: plateInput, z_mm: z.number().gt(0).max(10000).describe('Height of the mark to remove, mm') }),
    hints: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
    async approval(i) {
      return { title: `Remove the layer mark at ${i.z_mm} mm on plate ${i.plate} of ${basename(i.project)}?`, lines: [], actions: [] }
    },
    async run(i) {
      const path = projectPath(d.policy, i.project)
      const r = removePlateMark(path, i.plate, i.z_mm)
      return {
        summary: `Removed the ${KIND_LABEL[r.removed.kind]} at ${r.removed.z} mm on plate ${i.plate}; ${r.marks.length} mark${r.marks.length === 1 ? '' : 's'} left`,
        output: { project: path, plate: i.plate, removed: markOut(r.removed), marks: r.marks.map(markOut) },
      }
    },
  })
