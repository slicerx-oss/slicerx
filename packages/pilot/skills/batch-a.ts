// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printers, scheduling and inventory skills.
import type { ToolShared } from '../src/shared'
import type { PilotTool } from '../src/tool'
import { createEnergyEstimate } from './energy_estimate/index'
import { createMaterialRecommend } from './material_recommend/index'
import { createOvernightReadiness } from './overnight_readiness/index'
import { createPrinterMatch } from './printer_match/index'
import { createFleetOverview } from './fleet_overview/index'
import { createSetupTools } from './printer_setup/index'
import { createSchedule } from './schedule/index'
import { createSpoolFit } from './spool_fit/index'
import { createSpoolInventory } from './spool_inventory/index'

export function create(shared: ToolShared): PilotTool<never>[] {
  return [
    createPrinterMatch(shared),
    createFleetOverview(),
    createMaterialRecommend(),
    createSchedule(shared),
    createSpoolInventory(shared),
    createSpoolFit(shared),
    createOvernightReadiness(shared),
    createEnergyEstimate(shared),
    ...createSetupTools(),
  ] as PilotTool<never>[]
}
