// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { selectionState } from '../agent-bridge/ui-state'
import { editionHasCad } from '../edition'
import { PICK_KINDS, pickKeysOn, type PickKind } from '../plate/pick-filter'
import { setPickKind } from '../plate/sub-pick'
import { toolStore } from '../plate/tools'
import { get } from '../state/store'
import { LinkError } from './methods-error'

function available(): boolean {
  const s = get()
  const tool = toolStore.getState()
  const selecting = tool.tool === 'select' || (tool.tool === 'move' && !tool.moveArrows)
  return editionHasCad() && pickKeysOn(s) && s.objectTool === null && selecting
}

export function readPickFilter() {
  return { available: available(), ...selectionState(get()) }
}

export function setPickFilter(args: Record<string, unknown>) {
  if (!available()) throw new LinkError('busy', 'open Model and finish the active tool before changing the pick filter')
  if (Object.keys(args).some((k) => !['kind', 'mode'].includes(k)) || !(PICK_KINDS as readonly unknown[]).includes(args['kind'])) throw new LinkError('invalid_input', 'kind is object (Body), face or edge')
  const mode = args['mode'] === undefined ? 'only' : args['mode']
  if (mode !== 'only' && mode !== 'toggle') throw new LinkError('invalid_input', 'mode is only or toggle')
  setPickKind(args['kind'] as PickKind, mode)
  return readPickFilter()
}
