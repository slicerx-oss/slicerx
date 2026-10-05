// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A setting's tooltip. Kept apart from tip-host so the settings data and the figures load on demand,
// off the app's startup path.
import type { TipContent } from '@slicerx/ui'
import { settingDef } from '../adapters/settings'
import { settingFigure } from './setting-figures'

/** A setting's tip: its label, its note and, where one helps, a figure. The key shows in developer mode only. */
export function settingTip(key: string, developer = false): TipContent | null {
  const def = settingDef(key)
  if (!def) return null
  const body = def.note ?? def.help
  const figure = settingFigure(key)
  return { title: def.label, ...(body ? { body } : {}), ...(figure ? { figure } : {}), ...(developer ? { meta: key } : {}) }
}
