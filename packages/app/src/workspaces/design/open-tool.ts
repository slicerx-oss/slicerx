// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The one way to open an object tool. A modeling tool opens Design first, from any tab; Cut, Measure, Array and the
// mesh tools stay where they are.
import { editionHasCad } from '../../edition'
import { isCadTool, set } from '../../state/store'
import { opensDesign, type ToolId } from './shelf-tools'

export function openTool(tool: ToolId): void {
  if (isCadTool(tool) && opensDesign(tool) && editionHasCad()) set({ workspace: 'prepare', modelMode: 'design', objectTool: tool })
  else set({ objectTool: tool })
}
