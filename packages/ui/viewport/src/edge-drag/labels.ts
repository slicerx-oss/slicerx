// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag's strings, each one a host can replace through the `labels` option.

/** Every string the gesture shows or says. Defaults are in DEFAULT_EDGE_DRAG_LABELS. */
export interface EdgeDragLabels {
  /** The label of an edge that adds to another plate, from that plate's label. */
  addToPlate(plateLabel: string): string
  /** The label of the edge that adds a new plate (the bottom). */
  addToNewPlate: string
  /** The label of the edge that opens the list of the other plates (past three of them). */
  morePlates: string
  /** The one-time hint after a release short of the line. */
  hint: string
  /** What the live region says while a release would add to a plate. */
  releaseToPlate(plateLabel: string): string
  /** What the live region says while a release would add a new plate. */
  releaseToNewPlate: string
  /** What the live region says while the More plates list is open and no plate in it is picked. */
  pickFromList: string
  /** What the live region says while the part waits on More plates before its list opens. */
  holdForMore: string
  /** The short note after a drop with no plate bar on screen to fly to, from the label of the plate it went to. */
  movedToPlate(plateLabel: string): string
}

export const DEFAULT_EDGE_DRAG_LABELS: EdgeDragLabels = {
  addToPlate: (plate) => `+ Add to ${plate}`,
  addToNewPlate: '+ Add to new plate',
  morePlates: '+ More plates',
  hint: 'Drag past the line to move it',
  releaseToPlate: (plate) => `Release to add to ${plate}`,
  releaseToNewPlate: 'Release to add to a new plate',
  pickFromList: 'Move onto a plate in the list',
  holdForMore: 'Hold to see more plates',
  movedToPlate: (plate) => `Moved to ${plate}`,
}
