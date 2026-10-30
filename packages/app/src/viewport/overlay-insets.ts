// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How much of the viewport the overlays cover (the Preview legend, the layer strip, the playback bar), so the camera
// frames the plate's content in what is left. The rule itself is @slicerx/viewport's, which the plate edge drag uses
// for the room past each edge too.
export { OVERLAY_GAP, overlayInsets, type PxInsets, type Rect } from '@slicerx/viewport/edge-drag'

/**
 * The overlays the camera frames the plate around. A surface marked `data-no-frame` floats over the view and leaves the
 * framing alone: the legend's list, which opens over the top left corner and must not move the camera.
 */
export const FRAMED_OVERLAYS = '.sx-overlay:not([data-no-frame])'
