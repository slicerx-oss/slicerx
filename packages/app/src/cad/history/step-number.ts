// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The number a person sees for a step: its place in the design's timeline, where sketches count too, the way the
// timeline strip and the tree number it. A step the timeline does not list (an object outside the design) keeps its
// place in its own history. Every toast and label that names a step goes through here.
import type { Timeline } from '@slicerx/cad-history'
import { get, type AppState } from '../../state/store'

/** A step's place in the timeline, counting from 1, or undefined when the timeline does not list it. */
export function timelineNumber(items: Timeline['items'], objectId: string, stepId: string): number | undefined {
  const i = items.findIndex((it) => it.kind === 'feature' && it.body === objectId && it.id === stepId)
  return i < 0 ? undefined : i + 1
}

/** The number shown for step `index` of the object's history. */
export function stepNumber(objectId: string, index: number, s: Pick<AppState, 'plate' | 'historyEdit' | 'timeline'> = get()): number {
  const open = s.historyEdit?.objectId === objectId ? s.historyEdit.original : undefined
  const id = (open ?? s.plate.find((p) => p.id === objectId))?.history?.steps[index]?.id
  return (id !== undefined ? timelineNumber(s.timeline.items, objectId, id) : undefined) ?? index + 1
}

/** The number shown for step `index` of the object whose step is open for editing. */
export function editingNumber(index: number, s: Pick<AppState, 'plate' | 'historyEdit' | 'timeline'> = get()): number {
  return s.historyEdit ? stepNumber(s.historyEdit.objectId, index, s) : index + 1
}
