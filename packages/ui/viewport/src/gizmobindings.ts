// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Modifier keys, steps and layouts of the move, scale and paint tools, one set per look preset, read from the
// sources of the apps the presets imitate (Orca v2.4.2 and Bambu Studio: src/slic3r/GUI/Gizmos GLGizmoScale.cpp,
// GLGizmoMove.cpp, GLGizmoPainterBase.cpp, libslic3r TriangleSelector.cpp; PrusaSlicer 3.0 alpha: slic3r-shared
// src/Slic3r/App/Plater ScaleGizmo.cpp and PaintOnGizmoBase.cpp). SlicerX follows Bambu Studio. Pure data, no
// three.js; Settings edits it with `withGizmoOverrides`.

export type ModKey = 'shift' | 'ctrl' | 'alt'
export type PaintToolId = 'brush' | 'triangle' | 'fill' | 'smart' | 'height' | 'gap' | 'replace'

export interface ScaleBindings {
  /**
   * `bottom`: x and y handles at the middle of the bottom edges, a z handle on top, uniform handles at the
   * bottom corners (Orca, Bambu Studio). `faces`: a handle at the center of each of the six faces and uniform
   * handles at the corners of the middle height (PrusaSlicer 3.0).
   */
  layout: 'bottom' | 'faces'
  /** What a drag scales about. Orca and Bambu Studio scale about the bottom center so the model stays on the bed. */
  pivot: 'bottom-center' | 'center'
  /** Holding this pins the opposite handle while an axis handle is dragged. Null: no such key. */
  pinKey: ModKey | null
  /** Orca reads the pin key when the drag starts; Bambu Studio follows the key while dragging. */
  pinMode: 'at-start' | 'live'
  /** A pinned corner handle in Orca keeps the opposite corner and scales x and y only; in Bambu Studio corners ignore the pin. */
  cornerPinLocksZ: boolean
  /** Holding this snaps the factor to `snapStep`. */
  snapKey: ModKey | null
  snapStep: number
  /**
   * How the pointer becomes a factor. `plane`: the ray meets the plane of the handle (Orca). `point`: the point of the
   * ray nearest the handle's start position (Bambu Studio). `line`: the point of the handle line nearest the ray,
   * measured from where the drag began (PrusaSlicer).
   */
  ratio: 'plane' | 'point' | 'line'
  /** Smallest size a drag may leave, mm (PrusaSlicer keeps at least 1 mm). Null: only the factor limit applies. */
  minSizeMm: number | null
  /** Orca's Alt: scale each model about its own origin instead of a shared pivot. It changes nothing for one model. */
  independentKey: ModKey | null
}

export interface MoveBindings {
  /** Holding this snaps a move to `snapStepMm`. Null: no snapping. */
  snapKey: ModKey | null
  snapStepMm: number
}

export interface RotateBindings {
  /**
   * Holding this snaps the angle of a ring drag to `snapStepDeg`. None of the three apps has such a key (Orca, Bambu Studio and
   * PrusaSlicer snap by where the cursor sits on the ring, GLGizmoRotate::on_dragging); SlicerX uses the key the look snaps moves
   * and scales with, Shift, on every look.
   */
  snapKey: ModKey | null
  snapStepDeg: number
}

export interface PaintBindings {
  /** Holding this while painting erases. */
  eraseKey: ModKey | null
  /**
   * What the right button does on the color layer: `camera` leaves it to the camera (Orca, Bambu Studio), or
   * `second-state` paints the second brush color (PrusaSlicer). On the seam and support layers it always paints a blocker.
   */
  colorRightButton: 'camera' | 'second-state'
  /** The key that changes radius, height band, fill angle and gap area with the wheel, and the key that moves the clipping plane. */
  wheelParamKey: ModKey
  wheelClipKey: ModKey
  radius: { default: number; min: number; max: number; step: number }
  /** The edge limit of splitting is `radius / divisor`, at most `cap` mm when given. */
  detail: { divisor: number; cap: number | null }
  /** `bottom`: a band of the thickness starting at the pointer height; `center`: centered on it. */
  height: { anchor: 'bottom' | 'center'; default: number; min: number; max: number; step: number }
  /** Orca and Bambu Studio share one angle for smart fill and bucket fill; PrusaSlicer keeps two. */
  angle: { smart: number; bucket: number; shared: boolean; min: number; max: number; step: number }
  /** Gap fill (Orca, Bambu Studio): patches smaller than the area merge into a neighbor. Null: no gap fill. */
  gapArea: { default: number; min: number; max: number; step: number } | null
  tools: readonly PaintToolId[]
}

export interface GizmoBindings {
  scale: ScaleBindings
  move: MoveBindings
  rotate: RotateBindings
  paint: PaintBindings
}

const ORCA_TOOLS: readonly PaintToolId[] = ['brush', 'triangle', 'height', 'fill', 'smart', 'gap']

export const BAMBU_GIZMO: GizmoBindings = {
  scale: { layout: 'bottom', pivot: 'bottom-center', pinKey: 'ctrl', pinMode: 'live', cornerPinLocksZ: false, snapKey: 'shift', snapStep: 0.05, ratio: 'point', minSizeMm: null, independentKey: null },
  move: { snapKey: 'shift', snapStepMm: 1 },
  rotate: { snapKey: 'shift', snapStepDeg: 15 },
  paint: {
    eraseKey: 'shift',
    colorRightButton: 'camera',
    wheelParamKey: 'ctrl',
    wheelClipKey: 'alt',
    radius: { default: 1, min: 0.4, max: 8, step: 0.2 },
    detail: { divisor: 5, cap: 0.2 },
    height: { anchor: 'bottom', default: 0.2, min: 0.1, max: 8, step: 0.2 },
    angle: { smart: 30, bucket: 30, shared: true, min: 0, max: 90, step: 1 },
    gapArea: { default: 0, min: 0, max: 5, step: 0.2 },
    tools: ORCA_TOOLS,
  },
}

export const ORCA_GIZMO: GizmoBindings = {
  scale: { layout: 'bottom', pivot: 'bottom-center', pinKey: 'ctrl', pinMode: 'at-start', cornerPinLocksZ: true, snapKey: 'shift', snapStep: 0.05, ratio: 'plane', minSizeMm: null, independentKey: 'alt' },
  move: { snapKey: 'shift', snapStepMm: 1 },
  rotate: { snapKey: 'shift', snapStepDeg: 15 },
  paint: { ...BAMBU_GIZMO.paint, detail: { divisor: 5, cap: 0.05 } },
}

export const PRUSA_GIZMO: GizmoBindings = {
  scale: { layout: 'faces', pivot: 'center', pinKey: null, pinMode: 'at-start', cornerPinLocksZ: false, snapKey: null, snapStep: 0.05, ratio: 'line', minSizeMm: 1, independentKey: null },
  move: { snapKey: null, snapStepMm: 1 },
  rotate: { snapKey: 'shift', snapStepDeg: 15 },
  paint: {
    eraseKey: 'shift',
    colorRightButton: 'second-state',
    wheelParamKey: 'alt',
    wheelClipKey: 'ctrl',
    radius: { default: 2, min: 0.4, max: 8, step: 0.2 },
    detail: { divisor: 5, cap: null },
    height: { anchor: 'center', default: 1, min: 0.1, max: 10, step: 0.1 },
    angle: { smart: 30, bucket: 90, shared: false, min: 0, max: 90, step: 1 },
    gapArea: null,
    tools: ['brush', 'triangle', 'height', 'fill', 'smart', 'replace'],
  },
}

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T
export type GizmoOverrides = DeepPartial<GizmoBindings>

/** A person's edits from Settings applied on top of a preset's gizmo bindings. The preset is not changed. */
export function withGizmoOverrides(base: GizmoBindings, o: GizmoOverrides): GizmoBindings {
  const merge = <T extends object>(a: T, b: DeepPartial<T> | null | undefined): T => {
    if (!b) return a
    const out = { ...a } as Record<string, unknown>
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue
      const cur = out[k]
      out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? merge(cur as object, v as DeepPartial<object>) : v
    }
    return out as T
  }
  return { scale: merge<ScaleBindings>(base.scale, o.scale), move: merge<MoveBindings>(base.move, o.move), rotate: merge<RotateBindings>(base.rotate, o.rotate), paint: merge<PaintBindings>(base.paint, o.paint) }
}
