// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The engine's CAD shapes as a history step keeps them (sx-geom json_cad.rs), in millimeters and degrees,
// world coordinates. The app's typed engine calls (app geom/cad.ts) re-export them.

export type Vec2 = [number, number]

export type Vec3 = [number, number, number]

/** 16 numbers, column-major, like three.js Matrix4.elements. */
export type Mat4 = number[]

export type ArraySpec =
  | { kind: 'linear'; count: number; step: Vec3; count2?: number; step2?: Vec3 }
  | { kind: 'circular'; count: number; center: Vec3; axis?: Vec3; angleDeg?: number; rotateCopies?: boolean }

export interface FaceFrame {
  origin: Vec3
  /** Outward normal. */
  normal: Vec3
  u: Vec3
  v: Vec3
}

export interface Polygon {
  outer: Vec2[]
  holes: Vec2[][]
}

export type Shape =
  | { type: 'rectangle'; widthMm: number; heightMm: number; cornerRadiusMm?: number }
  | { type: 'circle'; diameterMm: number }
  | { type: 'slot'; lengthMm: number; widthMm: number }
  | { type: 'polygon'; sides: number; diameterMm: number; fit?: 'inscribed' | 'circumscribed' }
  | { type: 'text'; text: string; sizeMm: number; letterSpacingMm?: number; lineSpacing?: number; align?: 'left' | 'center' | 'right' }

/** Free outlines for shapeProfile and extrudeShape, beside the typed shapes. */
export type FreeShape =
  /** Closed loops in frame coordinates; check them first with checkSketch. */
  | { type: 'sketch'; loops: SketchLoop[] }
  /** The filled outline of SVG artwork (colors merged), widthMm wide, centered on the placement, SVG up along v. */
  | { type: 'svg'; svg: string; widthMm: number; toleranceMm?: number }

export interface Placement {
  /** Center in frame coordinates. */
  center?: Vec2
  rotationDeg?: number
}

export interface ExtrudeSpec {
  distanceMm: number
  extent?: 'oneSide' | 'symmetric' | 'twoSides'
  distance2Mm?: number
  flip?: boolean
  /** -45 to 45; positive narrows away from the face. */
  taperDeg?: number
  operation?: 'new' | 'join' | 'cut'
}

/** One piece of a loop, starting where the previous one ended. */
export type SketchSegment =
  | { type: 'line'; to: Vec2 }
  /** angleDeg: direction in the plane, 0 along u, counterclockwise. */
  | { type: 'line'; lengthMm: number; angleDeg: number }
  /** turnDeg: relative to the end of the previous segment, positive turns left. */
  | { type: 'line'; lengthMm: number; turnDeg: number }
  /** Around center, sweepDeg positive counterclockwise. */
  | { type: 'arc'; center: Vec2; sweepDeg: number }
  | { type: 'arc'; to: Vec2; through: Vec2 }
  | { type: 'arc'; to: Vec2; radiusMm: number; clockwise?: boolean; large?: boolean }
  /** Tangent to the previous segment; positive sweepDeg turns left. */
  | { type: 'arc'; radiusMm: number; sweepDeg: number }

/** A loop closes when its last segment ends within 0.001 mm of start. */
export type SketchLoop =
  | { start: Vec2; segments: SketchSegment[] }
  | { type: 'circle'; center: Vec2; diameterMm: number }
  | { points: Vec2[] }

/** A face that moved, as face.push reports it (world). Pass it to evaluateDimensions. */
export interface MovedFace {
  frame: FaceFrame
  outline: Polygon[]
  distanceMm: number
}

/** An edge as the ops take it: its end points and the outward normal of its first face (world). Store it as is. */
export interface EdgeRef {
  a: Vec3
  b: Vec3
  /** The face that takes distanceMm in a two distance chamfer. */
  face: Vec3
  /** The ends moved with a face they lie on (a history replay): the edge is found along its line. */
  moved?: boolean
  /** A round edge (a hole's rim, a boss's root): the center of the circle; `a` is a corner of it and `b` the same. */
  center?: Vec3
  /** The keys of the two faces either side, the one `face` faces first: the edge is found between them first. */
  keys?: [number, number]
}

/** A round hole: its entry center (world) and the way out through it, its size and depth. */
export interface Hole {
  entry: Vec3
  axis: Vec3
  diameterMm: number
  depthMm: number
  /** Open at the far end too. */
  through: boolean
}

/** What a hole becomes, mm. A counterbore or a countersink is at the entry. */
export interface HoleSpec {
  diameterMm: number
  /** A blind hole's new depth; its own depth when absent. A through hole stays through. */
  depthMm?: number
  counterbore?: { diameterMm: number; depthMm: number }
  countersink?: { diameterMm: number; angleDeg: number }
}

/** A face to leave open: a point on it and its outward normal, world. */
export interface OpenFace {
  at: Vec3
  normal: Vec3
  /** The face's key, looked for first (docs/cad-history.md, "Face keys"). */
  key?: number
}

/** An ISO coarse size. */
export interface ThreadSize {
  name: string
  majorMm: number
  pitchMm: number
}

/** A round surface a thread can go on (world): where it starts, the way out through that end, its size and length. */
export interface ThreadTarget {
  start: Vec3
  axis: Vec3
  diameterMm: number
  lengthMm: number
  /** A hole's wall, not a boss or rod. */
  internal: boolean
  /** Open at the far end too; otherwise the thread stops half a pitch short of it. */
  openEnd: boolean
  /** The size that suits it, and every size there is. */
  suggested: string
  sizes: ThreadSize[]
}

/** Where a thread goes, as a history step keeps it. */
export type ThreadPlace = Omit<ThreadTarget, 'suggested' | 'sizes'>

export interface ThreadSpec {
  size: string
  /** From the start; the whole surface when absent. */
  lengthMm?: number
  /** Per side: an external thread this much smaller, an internal one this much larger. */
  clearanceMm: number
}
