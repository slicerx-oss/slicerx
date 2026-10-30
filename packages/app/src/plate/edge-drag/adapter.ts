// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's side of plate edge drag (@slicerx/viewport/edge-drag): its plates, the move as one undo step, the bars over
// the view, the plate picker the part drops into (or, with no picker on screen, a toast that says where it went), and
// showing the plate after with the parts selected. The gesture, its overlay and its look are the viewport's; this file
// only answers its questions from the app's store.
import type { EdgeDragOptions } from '@slicerx/viewport/edge-drag'
import { appStore, toast } from '../../state/store'
import { FRAMED_OVERLAYS } from '../../viewport/overlay-insets'
import { TOWER_ID } from '../tower'
import { follow, sendToPlate } from './commit'

/** The app's plate edge drag options. `putBack` returns the objects to the plate's own places when nothing moved. */
export function appEdgeDrag(stage: HTMLElement, putBack: () => void): EdgeDragOptions {
  return {
    plates: () => appStore.getState().plates.map((p, i) => ({ id: p.id, label: `Plate ${i + 1}`, order: i })),
    activePlate: () => appStore.getState().activePlate,
    move(ids, dest) {
      const to = sendToPlate(ids, dest === 'new' ? 'new' : { plateId: dest.plate })
      if (!to) putBack()
      return to ?? undefined
    },
    obstacles: () => [...document.querySelectorAll(FRAMED_OVERLAYS)].map((el) => el.getBoundingClientRect()),
    dropTarget: () => {
      const r = document.querySelector('[data-testid="plate-picker-current"]')?.getBoundingClientRect()
      return r && r.width > 0 ? r : null
    },
    notify: (message) => toast(message, 'ok'),
    onSwitch: (plateId, ids) => follow(plateId, ids),
    canMove: (ids) => !ids.includes(TOWER_ID) && !appStore.getState().historyEdit,
    stage,
  }
}
