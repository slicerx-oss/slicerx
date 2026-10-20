// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { CommandSpec } from '@slicerx/contracts'
import { createSkills } from '../../skills/index'
import type { SettingsPlanner } from '../planner'
import { createShared, type ToolShared } from '../shared'
import type { PilotTool } from '../tool'
import { kbTools } from './kb'
import { partsTool } from './parts'
import type { PartsTable } from '../parts/table'
import type { MemoryStore } from '../memory/facts'
import { commandTools, projectTool, reportTool, webTool } from './misc'
import { printerTools } from './printers'
import { runTools } from './run'
import { settingsTools } from './settings'

/** `memory` is the person's notes, for the tools that read them (run.target); without it they go by what was said. */
export function builtinTools(opts: { planner: SettingsPlanner | undefined; commands: CommandSpec[]; shared?: ToolShared; parts?: PartsTable; memory?: MemoryStore }): PilotTool<never>[] {
  const shared = opts.shared ?? createShared()
  return [...createSkills(shared), ...kbTools(), partsTool(opts.parts), ...settingsTools(opts.planner), webTool(), projectTool(), ...printerTools(shared), ...runTools({ memory: opts.memory }), reportTool(), ...commandTools(opts.commands, shared)]
}
