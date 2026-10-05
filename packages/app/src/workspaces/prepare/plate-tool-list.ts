// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate toolbar's tools as data, so the toolbar and the setup preview draw the same list.
import type { IconName, KeyAction } from '@slicerx/ui'
import type { TipId } from '../../lib/tips'
import type { Tool } from '../../plate/tools'

export interface PlateToolSpec {
  tool: Tool
  label: string
  icon: IconName
  key: KeyAction
  tip: TipId
}

export const PLATE_TOOLS: readonly PlateToolSpec[] = [
  { tool: 'move', label: 'Move', icon: 'move', key: 'tool.move', tip: 'tool.move' },
  { tool: 'rotate', label: 'Rotate', icon: 'rotate', key: 'tool.rotate', tip: 'tool.rotate' },
  { tool: 'scale', label: 'Scale', icon: 'scale', key: 'tool.scale', tip: 'tool.scale' },
  { tool: 'face', label: 'Lay on face', icon: 'lay-flat', key: 'tool.placeOnFace', tip: 'tool.placeOnFace' },
  { tool: 'paint', label: 'Paint', icon: 'color-painting', key: 'tool.supports', tip: 'tool.paint' },
]

export const BRIM_TOOL: PlateToolSpec = { tool: 'brim', label: 'Brim ears', icon: 'nozzle-custom', key: 'tool.supports', tip: 'tool.brim' }
