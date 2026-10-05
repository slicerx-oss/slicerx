// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slicing and geometry skills: optimize to a target, orientation search,
// setup comparison, risk report, supports, fit check, G-code inspection and
// variable layer planning.
import type { ToolShared } from '../src/shared'
import type { PilotTool } from '../src/tool'
import { createCompareSetups } from './compare_setups/index'
import { createFitCheck } from './fit_check/index'
import { createGcodeInspect } from './gcode_inspect/index'
import { createOptimizeToTarget } from './optimize_to_target/index'
import { createOrientationSearch } from './orientation_search/index'
import { createRiskReport } from './risk_report/index'
import { createSupports } from './supports/index'
import { createSmartLayer } from './smart_layer/index'

export function create(shared: ToolShared): PilotTool<never>[] {
  return [
    createOptimizeToTarget(),
    createOrientationSearch(),
    createCompareSetups(),
    createRiskReport(),
    createSupports(),
    createFitCheck(),
    createGcodeInspect(shared),
    createSmartLayer(),
  ] as PilotTool<never>[]
}
