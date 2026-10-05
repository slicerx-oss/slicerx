// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The camera and mouse map for a look and feel choice: the preset's map from the viewport, with the
// person's per-button remap, zoom and free camera overrides on top. Takes the viewport functions as
// arguments so the shell never imports @slicerx/viewport statically (it loads on first use).
import type { LookAndFeelChoice } from '@slicerx/contracts'
import type { ButtonRemap, ControlsMap, ControlsPresetId, GizmoOverrides } from '@slicerx/viewport'

/** What `LookAndFeelChoice.overrides.controls` holds. */
export interface ControlOverrides {
  remap?: ButtonRemap
  invert?: boolean
  zoomToCursor?: boolean
  freeCamera?: boolean
  /** Modifier keys and steps of the move, scale and paint tools. */
  gizmo?: GizmoOverrides
}

export interface ControlsApi {
  controlsPreset(id: ControlsPresetId): ControlsMap
  withRemap(map: ControlsMap, remap: ButtonRemap): ControlsMap
  /** Optional so a host that has not loaded the gizmo bindings still gets the camera map. */
  withGizmo?(map: ControlsMap, o: GizmoOverrides): ControlsMap
}

export function controlOverrides(choice: LookAndFeelChoice): ControlOverrides {
  return (choice.overrides?.controls ?? {}) as ControlOverrides
}

export function controlsFor(api: ControlsApi, choice: LookAndFeelChoice): ControlsMap {
  const o = controlOverrides(choice)
  const base = api.controlsPreset(choice.id)
  const remapped = o.remap && Object.keys(o.remap).length ? api.withRemap(base, o.remap) : base
  const map = o.gizmo && Object.keys(o.gizmo).length && api.withGizmo ? api.withGizmo(remapped, o.gizmo) : remapped
  return {
    ...map,
    wheel: { invert: o.invert ?? map.wheel.invert, zoomToCursor: o.zoomToCursor ?? map.wheel.zoomToCursor },
    freeCamera: o.freeCamera ?? map.freeCamera,
  }
}

/** The choice with its control overrides replaced; drops the overrides object when it ends up empty. */
export function withControlOverrides(choice: LookAndFeelChoice, next: ControlOverrides): LookAndFeelChoice {
  const clean: ControlOverrides = {}
  if (next.remap && Object.keys(next.remap).length) clean.remap = next.remap
  if (next.invert !== undefined) clean.invert = next.invert
  if (next.zoomToCursor !== undefined) clean.zoomToCursor = next.zoomToCursor
  if (next.freeCamera !== undefined) clean.freeCamera = next.freeCamera
  if (next.gizmo && Object.keys(next.gizmo).length) clean.gizmo = next.gizmo
  const { controls: _old, ...rest } = choice.overrides ?? {}
  const overrides = Object.keys(clean).length ? { ...rest, controls: clean as Record<string, unknown> } : rest
  return Object.keys(overrides).length ? { id: choice.id, overrides } : { id: choice.id }
}
