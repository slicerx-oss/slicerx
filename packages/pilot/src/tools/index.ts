// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { CommandSpec } from '@slicerx/contracts'
import { createSkills } from '../../skills/index'
import type { SettingsPlanner } from '../planner'
import { createShared, type ToolShared } from '../shared'
import type { PilotTool } from '../tool'
import { kbTools } from './kb'
import { commandTools, projectTool, reportTool, webTool } from './misc'
import { printerTools } from './printers'
import { settingsTools } from './settings'

export function builtinTools(opts: { planner: SettingsPlanner | undefined; commands: CommandSpec[]; shared?: ToolShared }): PilotTool<never>[] {
  const shared = opts.shared ?? createShared()
  return [...createSkills(shared), ...kbTools(), ...settingsTools(opts.planner), webTool(), projectTool(), ...printerTools(shared), reportTool(), ...commandTools(opts.commands)]
}
