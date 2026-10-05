// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Geometry skills: mesh analysis and repair, hollowing, embossing, resume
// planning, parts from a description, and hole sizing for fasteners and fits.
// The upgraded cut, orient and calibrate skills are registered with the core set.
import type { ToolShared } from '../src/shared'
import type { PilotTool } from '../src/tool'
import { createEmboss } from './emboss/index'
import { createHollow } from './hollow/index'
import { createMakeModel } from './make_model/index'
import { createMeshAnalyze } from './mesh_analyze/index'
import { createMeshRepair } from './mesh_repair/index'
import { createResumeFromLayer } from './resume_from_layer/index'
import { createScaleWithTolerance } from './scale_with_tolerance/index'
import { createTextToPart } from './text_to_part/index'
import { createThreadsAndFits } from './threads_and_fits/index'

export function create(_shared: ToolShared): PilotTool<never>[] {
  return [
    createMakeModel(),
    createMeshAnalyze(),
    createMeshRepair(),
    createHollow(),
    createEmboss(),
    createResumeFromLayer(),
    createTextToPart(),
    createThreadsAndFits(),
    createScaleWithTolerance(),
  ] as PilotTool<never>[]
}
