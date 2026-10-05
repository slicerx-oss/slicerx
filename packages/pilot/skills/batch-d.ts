// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ToolShared } from '../src/shared'
import type { PilotTool } from '../src/tool'
import { createAmsMapping } from './ams_mapping/index'
import { createKbSources } from './kb_sources/index'
import { createMulticolorAssign } from './multicolor_assign/index'
import { createPrinterConfigCheck } from './printer_config_check/index'
import { createRegionModifiers } from './region_modifiers/index'

export function create(_shared: ToolShared): PilotTool<never>[] {
  return [createKbSources(), createAmsMapping(), createMulticolorAssign(), createRegionModifiers(), createPrinterConfigCheck()] as PilotTool<never>[]
}
