// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { appPlateInputs } from '@slicerx/mcp/toolset'
import { history, inStep } from '../plate/history'
import { findPlate } from '../plate/plate-step'
import { addPlate, allPlates, duplicatePlate, moveObjectsToPlate, removePlate, renamePlate, setPlateSettings } from '../plate/plates'
import { toolStore } from '../plate/tools'
import { platesState } from './plate-state'
import { get, toast, type PlateSettings } from '../state/store'
import { LinkError } from './methods-error'

const settings = (value: ReturnType<typeof appPlateInputs.settings.parse>['settings']): PlateSettings =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as PlateSettings

async function ready() {
  const { replaying } = await import('../cad/history/ops')
  const s = get()
  if (s.workspace !== 'prepare' || s.modelMode !== 'slice' || s.plateLoading || s.dragging || s.liveEdit || s.objectTool || s.historyEdit || s.slice.status === 'running' ||
    ['paint', 'brim', 'face', 'probe'].includes(toolStore.getState().tool) || allPlates(s).some((p) => p.objects.some((e) => replaying(e.id)))) {
    throw new LinkError('busy', 'plate edits need Slice open, with no tool, load, slice or history edit in progress')
  }
}

/** One call shares the toolbar's undo step, after all input and busy checks finish. */
export async function editPlate<K extends keyof typeof appPlateInputs>(action: K, args: Record<string, unknown>, client: string) {
  const parsed = appPlateInputs[action].safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  await ready()
  const input = parsed.data
  const s = get()
  const id = 'plate' in input ? findPlate(s.plates, input.plate) : undefined
  if ('plate' in input && !id) throw new LinkError('not_found', 'no such plate; app_plates lists its numbers and ids')
  const target = allPlates(s).find((p) => p.id === id)
  if (action === 'remove') {
    if (s.plates.length <= 1) throw new LinkError('refused', 'the last plate cannot be removed')
    if (target!.objects.length && !('deleteObjects' in input && input.deleteObjects)) throw new LinkError('refused', 'the plate contains objects; give deleteObjects: true to remove them too')
    if (target!.objects.some((e) => e.locked)) throw new LinkError('refused', 'the plate contains locked objects')
  }
  if ('objects' in input) {
    if (id === s.activePlate) throw new LinkError('invalid_input', 'the destination is already the shown plate')
    for (const object of input.objects) {
      const e = s.plate.find((o) => o.id === object)
      if (!e) throw new LinkError('not_found', `no object ${object} on the shown plate; use an id from app_plates`)
      if (e.locked) throw new LinkError('refused', `${e.name} is locked`)
    }
  }
  history()
  let changedPlate = id
  inStep({}, () => {
    switch (action) {
      case 'add': {
        const i = input as ReturnType<typeof appPlateInputs.add.parse>
        changedPlate = addPlate(i.settings === undefined ? undefined : settings(i.settings))
        if (i.name) renamePlate(changedPlate, i.name)
        break
      }
      case 'duplicate': {
        changedPlate = duplicatePlate(id!)!
        if ('name' in input && input.name) renamePlate(changedPlate, input.name)
        break
      }
      case 'rename': renamePlate(id!, (input as { name: string }).name); break
      case 'settings': {
        const i = input as ReturnType<typeof appPlateInputs.settings.parse>
        setPlateSettings(id!, settings(i.settings), i.replace)
        break
      }
      case 'remove': removePlate(id!); break
      case 'move': {
        if (!moveObjectsToPlate(id!, (input as { objects: string[] }).objects, true)) throw new LinkError('refused', 'the objects do not all fit on the destination plate; nothing moved')
        break
      }
    }
  })
  toast(`${client} changed the project plates.`, 'info', { label: 'Undo', run: () => void history().undo() })
  return { ...platesState(), changedPlate }
}
