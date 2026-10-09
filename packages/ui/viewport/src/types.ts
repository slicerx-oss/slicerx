// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Public types of @slicerx/viewport. Coordinates in every public call are the
// slicer frame used by the Plate contract: millimeters, Z up, origin at the
// bed's front left corner. The renderer converts to three.js Y-up internally.
import type { ToolChangerSpec } from './toolchanger'
import type { PurgePlan } from './purge'
import type { HeadModel } from './heads'
import type { StrikeMark } from './strikes'
import type { GantryHit, GantrySpec } from './gantry'
import type { Guides } from './guides'
import type { DimensionMark, SketchCursor, SketchScene } from './cadtools'
import type { Bed, PreviewBuffers } from '@slicerx/contracts'
import type { ControlsMap, ControlsPresetId } from './controls'
import type { ViewportTheme } from './palette'

export type Backend = 'auto' | 'webgl2' | 'webgpu'
export type Quality = 'high' | 'balanced' | 'low'
export type ViewportMode = 'prepare' | 'preview'
/** Prepare look. */
export type RenderMode = 'studio' | 'clay' | 'xray' | 'overhang' | 'filament'
/** Preview coloring. `tool` is the filament color of each segment's tool. */
export type ColorMode = 'feature' | 'tool' | 'speed' | 'flow' | 'layerTime' | 'width' | 'height' | 'fan' | 'temperature'
/** `fit` frames the scene or selection from the current direction; `bed` frames the whole bed from it. */
export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'fit' | 'bed' | 'plate'
export type Projection = 'perspective' | 'orthographic'
/** How Prepare draws models: `shaded`, `edges` (shaded with feature edges, the default) or `wireframe`. X-ray is a RenderMode. */
export type DisplayStyle = 'shaded' | 'edges' | 'wireframe'
/** `face` is lay on face: hovering highlights the flat face under the cursor and a click emits `facepick`. */
/**
 * `face` is lay on face. `paint` paints color, seams and supports. `scale` follows OrcaSlicer's scale gizmo: x and y
 * handles at the middle of the bottom edges, a z handle on top, uniform handles at the bottom corners. A drag scales about
 * the bottom center of the model's box, so it stays on the bed. Hold Ctrl when the drag starts to keep the opposite
 * handle fixed (a corner then scales x and y only). Shift snaps the factor to 5 percent steps.
 */
export type PlateTool = 'select' | 'move' | 'rotate' | 'face' | 'paint' | 'scale' | 'brim' | 'probe'
/** With the `probe` tool a click only reports what is under the cursor (`pick`): nothing is selected or moved. Measure and the shape tools use it. */
export type FilamentFinish = 'basic' | 'matte' | 'silk' | 'petg' | 'translucent'

/** How printed toolpaths shine: matte, satin (everyday PLA), glossy (PETG and the like) or silk, which streaks along each bead. */
export type ToolpathFinish = 'matte' | 'satin' | 'glossy' | 'silk'

/** The bed under the print: the outline and grid only, or a build plate surface under them. */
export type PlateStyle = 'grid' | 'textured-pei' | 'smooth-pei' | 'cool' | 'engineering'

/** Preview data beyond SXPV v1. Per-segment arrays follow the segment order of the buffer. */
export interface PreviewExtras {
  /** Fan speed, 0 to 100, per segment. */
  fanPct?: ArrayLike<number>
  /** Nozzle temperature in degrees C per segment. */
  nozzleC?: ArrayLike<number>
  /** x, y, z of each retraction, bed frame mm. */
  retractions?: Float32Array
  /** x, y, z of each layer seam, bed frame mm. */
  seams?: Float32Array
  /** x, y, z where the nozzle lifts (z hop), bed frame mm. */
  lifts?: Float32Array
  /** x, y, z where a wipe starts, bed frame mm. */
  wipes?: Float32Array
  /** x, y, z of each tool or filament change, bed frame mm. */
  toolChanges?: Float32Array
  /** x, y, z of each pause, bed frame mm. */
  pauses?: Float32Array
}

/** Kinds of point markers in Preview. */
export type MarkerKind = 'retractions' | 'seams' | 'lifts' | 'wipes' | 'toolChanges' | 'pauses'

/** Value ranges behind the color schemes, in the units shown in a legend. `fan` and `temperature` are null without extras. */
export interface PreviewRanges {
  /** mm/s */
  speed: [number, number]
  /** mm3/s */
  flow: [number, number]
  /** mm */
  width: [number, number]
  /** mm */
  height: [number, number]
  /** percent */
  fan: [number, number] | null
  /** degrees C */
  temperature: [number, number] | null
}

export interface LegendFeature {
  id: number
  label: string
  /** Color as drawn, theme applied. */
  color: string
  /** Extrusion time in seconds, from path length over speed. */
  timeS: number
  lengthMm: number
  visible: boolean
}

export interface ViewportOptions {
  /** `auto` picks WebGL2 today; see README, "Backend". */
  backend?: Backend
  /** `high`: MSAA 4x, SSAO, FXAA, 2048 shadows. `balanced`: SSAO at lower cost. `low`: no SSAO, 1x pixel ratio. */
  quality?: Quality
  /** Upper bound for the device pixel ratio. Default 2. */
  maxPixelRatio?: number
  /** Accessible label for the canvas. */
  label?: string
  /** Lower quality on its own when frames stay slow. Default true; benchmarks turn it off. */
  adaptive?: boolean
  /** Colors of the 3D scene. See ViewportTheme. Same as calling setTheme after creation. */
  theme?: ViewportTheme
  /** Camera and mouse controls at start. Default 'slicerx'. */
  controls?: ControlsPresetId | ControlsMap
  /**
   * The GL renderer the desktop shell read itself (Linux, where WebKit gives pages a made-up GPU name). It wins over
   * the name WebGL reports when deciding the quality tier and the software rendering warning.
   */
  gpuRenderer?: string | null
}

export interface ViewportPart {
  name: string
  /** Object-local positions, mm, Z up. */
  positions: Float32Array
  indices: Uint32Array | Uint16Array
  /** Filament color as #rrggbb. */
  color: string
  finish?: FilamentFinish
}

export interface ViewportObject {
  id: string
  name: string
  parts: ViewportPart[]
  /** 4x4 column-major, mm, Z up, origin at the bed's front left corner (PlateObject.transform). */
  transform: number[]
}

import type { NozzleZone } from './stage'
export type { NozzleZone }

export interface ViewportPlate {
  bed: Bed
  objects: ViewportObject[]
  /** Name of the bed surface, for example "Textured PEI". Not drawn: the floor is an outline. */
  surfaceLabel?: string
  /** Areas only one nozzle reaches (dual nozzle printers), in bed coordinates. */
  zones?: NozzleZone[]
  /** Parts of the bed nothing may print on (the printer's `bed_exclude_area`), polygons in bed coordinates, mm. Omitted keeps the current ones. */
  excluded?: (readonly [number, number])[][]
}

export interface PartStyle {
  color?: string
  finish?: FilamentFinish
}

export interface PickEvent {
  objectId: string | null
  partIndex: number | null
  /** Hit point in bed coordinates (mm, Z up), or null for a miss. */
  point: [number, number, number] | null
  /** The triangle hit, as an index into the part's index buffer, or null for a miss. */
  triangle: number | null
  /** Where the click meets the bed plane (mm), hit or miss; null when the ray runs away from the bed. */
  bed: [number, number] | null
  /** Shift was down: tools that pick several things add to the picks. */
  shift?: boolean
  /** Cmd (macOS) or Ctrl was down: Model's select toggles the face or edge under the click. */
  toggle?: boolean
}

/** Probe tool with hover on: the model point under the cursor, at most once a frame. */
export interface ProbeHover {
  objectId: string
  partIndex: number
  triangle: number
  /** Bed coordinates, mm. */
  point: [number, number, number]
}

/** What an edge op would remove (`cut`) and add (`join`), bed coordinates; either may be empty. */
export interface EdgePreviewSpec {
  cut: { positions: ArrayLike<number>; indices: ArrayLike<number> } | null
  join: { positions: ArrayLike<number>; indices: ArrayLike<number> } | null
}

/** What a paint stroke writes: filament color, seam position, support or fuzzy skin. */
export type PaintLayer = 'color' | 'seam' | 'support' | 'fuzzy'

export interface PaintSettings {
  layer: PaintLayer
  /**
   * `brush` paints under the cursor, `triangle` paints the single piece under it, `fill` floods connected pieces of the
   * state under the cursor (limited by `fillAngleDeg`, negative for no limit), `smart` floods whole triangles by surface
   * angle (`angleDeg`), `height` paints a band of `heightMm` at the height of the cursor on every part of the model,
   * `gap` merges small patches into a neighbor (`performGapFill`, Orca and Bambu Studio), `replace` turns every piece of
   * the color under the cursor into the new one (PrusaSlicer). Which tools exist depends on the look.
   */
  tool: 'brush' | 'triangle' | 'fill' | 'smart' | 'height' | 'gap' | 'replace'
  /** Sphere paints what the ball touches; circle paints through a disc along the view. Either spreads only over connected surface that faces the viewer, as OrcaSlicer's brush does. */
  shape: 'sphere' | 'circle'
  /** Brush radius in mm. OrcaSlicer allows 0.4 to 8 in steps of 0.2 (Ctrl and the wheel). */
  radiusMm: number
  /**
   * Color layer: 1-based filament slot. Seam and support layers: 1 enforcer, 2 blocker. On the seam and support layers
   * the left button always writes an enforcer and the right button a blocker, as in OrcaSlicer.
   */
  state: number
  /** Erase instead of painting. Holding Shift while painting erases too. */
  erase: boolean
  /** Split triangles so the brush edge follows the cursor. Off paints whole pieces by their center. */
  splitTriangles: boolean
  /** Longest edge left after splitting, mm. 0 is OrcaSlicer's rule, `min(radius / 5, 0.05)`. */
  detailMm: number
  /** Smart fill: largest bend between neighboring triangles, 0 to 90 degrees (default 30); negative removes the limit. */
  angleDeg: number
  /** Bucket fill: the same limit for the fill tool (Orca and Bambu Studio share one value with smart fill; PrusaSlicer defaults to 90). */
  fillAngleDeg: number
  /** Height tool: thickness of the band in mm. The range, step and whether the band starts at or is centered on the cursor depend on the look. */
  heightMm: number
  /** `paintHeightRange` from code: an explicit bed height range in mm. */
  heightRangeMm: [number, number]
  /** Gap fill: patches with less area than this (mm2) are merged. 0 to 5 in Orca. */
  gapAreaMm2: number
  /** The second brush color, painted by the right button when the look says so (PrusaSlicer). */
  secondState: number
  /** Paint only on overhangs steeper than this angle in degrees (Orca's paint on overhangs only). 0 is off. */
  overhangOnlyDeg: number
  /** Clipping plane, 0 off to 1 (moved with the wheel). What lies in front of it is hidden and not painted. */
  clipRatio: number
}

/** One triangle's paint before and after a stroke, as `paint_color` style text (null: unpainted). Undo applies `before`. */
export interface PaintEdit {
  triangle: number
  before: string | null
  after: string | null
}

export interface PaintStroke {
  objectId: string
  partIndex: number
  layer: PaintLayer
  edits: PaintEdit[]
}

/** A flat face of a model, in the bed frame (mm, Z up). */
export interface FacePick {
  objectId: string
  partIndex: number
  /** Outward unit normal after the object's transform. */
  normal: [number, number, number]
  /** Center of the object's bounds in bed coordinates, to rotate about. */
  centerBed: [number, number, number]
  areaMm2: number
  /** Hit point on the face. */
  point: [number, number, number]
}

export interface TransformEvent {
  id: string
  transform: number[]
  /** True on pointer up or when an arrange animation ends. Commit to app state then. */
  final: boolean
}

/** The cut tool's plane in bed coordinates (mm). `keep` decides which side the preview draws faint. */
export interface CutPlaneSpec {
  objectId: string
  point: [number, number, number]
  normal: [number, number, number]
  keep?: 'both' | 'above' | 'below'
  /** Connector placement: a click on the plane emits `cutconnector` with the point instead of moving the plane. */
  placeConnectors?: boolean
}

/** Push and pull: the picked face (bed coordinates, mm) and how far it moves along its outward normal. */
export interface PushSpec {
  face: { objectId: string; point: [number, number, number]; normal: [number, number, number] } | null
  distanceMm: number
  /** The swept prism of a 1 mm push (bed coordinates); the view stretches it to the distance while dragging. */
  prism?: { positions: ArrayLike<number>; indices: ArrayLike<number> } | null
}

/** A drag on a flat face while the push tool is on. `start` names the face pressed; `end` carries the final distance. */
export interface PushEvent {
  phase: 'start' | 'move' | 'end' | 'cancel'
  objectId: string
  partIndex: number
  triangle: number
  /** Where the face was pressed and its outward normal, bed coordinates. */
  point: [number, number, number]
  normal: [number, number, number]
  distanceMm: number
  /** The snap key is down: the distance is in whole millimeters. */
  snapped: boolean
}

/** The cursor on the sketch plane, in plane coordinates (mm). `mmPerPx` turns pixel tolerances into millimeters there. */
export interface SketchEvent {
  /** `hover` (at most one per frame), `click`, `context` (a right click), `drag` and `release` of a handle. */
  kind: 'hover' | 'click' | 'context' | 'drag' | 'release'
  at: [number, number]
  /** The handle being dragged, an index into the scene's handles. */
  handle?: number
  mmPerPx: number
  /** Client pixels, for a field placed at the cursor. */
  screen: [number, number]
  shift: boolean
  alt: boolean
}

export interface CameraState {
  /** Orbit center in bed coordinates, mm. */
  target: [number, number, number]
  /** 0 looks from the front of the bed, 90 from the right side. */
  azimuthDeg: number
  /** Angle above the bed plane. */
  elevationDeg: number
  distanceMm: number
}

export interface PathPick {
  segment: number
  /** 0-based layer index. */
  layer: number
  /** SXPV feature id (outer wall, sparse infill and so on). */
  feature: number
  /** 0-based tool. */
  tool: number
  /** 1-based G-code line, 0 when the buffer has none. */
  gcodeLine: number
  /** Index of the path's object in the slice request's `plate.objects`, -1 for none (skirt, shared brim, prime tower) or unknown. */
  object: number
  /** Where the click met the path, bed coordinates in mm. */
  point: [number, number, number]
  /** The click in CSS pixels from the canvas corner. */
  screen: [number, number]
}

export interface ViewportEvents {
  pick: PickEvent
  select: { ids: string[] }
  /** While a scale handle is dragged: the factors applied to the model's own axes since the drag began (`snapped`: Shift is down). */
  scale: { id: string; factors: [number, number, number]; uniform: boolean; snapped: boolean }
  /** The wheel changed a paint setting (radius, height band or fill angle). */
  paintsettings: PaintSettings
  /** A paint stroke, fill or height range ended. Edits carry before and after texts for undo. */
  paintstroke: PaintStroke
  /** Face tool: the face under the cursor, or null. */
  facehover: FacePick | null
  /** Probe tool with hover on: the model point under the cursor, or null off the model. */
  probehover: ProbeHover | null
  /** Face tool: a click on a face. Turn it with `layOnFaceTransform(transform, normal, centerBed)`. */
  facepick: FacePick
  /** Brim tool: a left click on a model (not on an ear). `point` is the hit in bed coordinates, mm. */
  brimadd: { objectId: string; point: [number, number, number] }
  /** Brim tool: a right click on an ear. */
  brimremove: { objectId: string; index: number }
  /** Brim tool: ears picked by a click (`set`, or `add` and `remove` with Shift and Alt), by a rectangle, or none (`set` with no indices) by a click on the model while some are selected. `indices` follow the array passed to `setBrimEars`. */
  brimselect: { objectId: string; indices: number[]; mode: 'set' | 'add' | 'remove' }
  /** Brim tool: an ear dragged. `point` is the hit on the model under the cursor (bed frame, mm). One event per move with `final: false`, then one with `final: true` on release. */
  brimmove: { objectId: string; index: number; point: [number, number, number]; final: boolean }
  /** Brim tool: Ctrl and the wheel (the wheel does not zoom). `delta` is 1 or -1 per notch. */
  brimwheel: { delta: 1 | -1 }
  /** Preview: a click on a toolpath (the segment, its layer and feature, the G-code line and where the click landed), or null for a click on nothing. */
  pathpick: PathPick | null
  transform: TransformEvent
  /** While a rotate ring is dragged: the turn since the drag began, about the bed's axis or the model's own (`space`). `snapped`: the snap key is down. One event with `final: true` on release. */
  rotate: { id: string; axis: 'x' | 'y' | 'z'; space: 'world' | 'local'; angleDeg: number; snapped: boolean; final: boolean }
  /** The cut plane moved or tilted in the view. One event per move with `final: false`, then one with `final: true` on release. */
  cutplane: { objectId: string; point: [number, number, number]; normal: [number, number, number]; final: boolean }
  /** Connector placement on the cut plane: where a click met the plane (bed coordinates, mm). */
  cutconnector: { objectId: string; point: [number, number, number] }
  /** Push and pull: a face dragged along its normal. Moves come at pointer rate; `end` comes once on release. */
  push: PushEvent
  /** Sketch mode: the cursor, clicks and handle drags on the sketch plane. */
  sketch: SketchEvent
  /** The camera moved (throttled to one per frame). For overlays such as dimension labels. */
  camera: { preset: ViewPreset | null }
  /** WebGL context lost or the renderer failed to start. */
  error: { message: string }
  /** The viewport lowered its own quality to keep frames smooth. Show `message` as a toast. */
  degrade: { message: string }
}

export interface ViewportStats {
  backend: 'webgl2' | 'webgpu'
  gpu: string
  quality: Quality
  pixelRatio: number
  width: number
  height: number
  frames: number
  /** Intervals between rendered frames while rendering continuously, ms (last 600). */
  frameMs: number[]
  /** CPU time spent rendering each frame, ms (last 600); includes the GPU wait while `setGpuTiming(true)`. */
  renderMs: number[]
  /** Time from the start of each frame until the GPU finished it, ms (last 600). Filled only while `setGpuTiming(true)`. */
  costMs: number[]
  /** Percentiles of costMs when GPU timing ran, otherwise of frameMs (which vsync caps). */
  p50: number
  p95: number
  /** ms from setPreview() to the first frame drawn with it, or null. */
  firstFrameMs: number | null
  /** Milliseconds from creating the viewport to its first drawn frame (plate and bed). */
  firstDrawMs: number | null
  drawCalls: number
  triangles: number
  segments: number
  aoOn: boolean
  /** Moving frames are drawn at this fraction of the still resolution. */
  motionScale: number
}

export interface Viewport {
  readonly canvas: HTMLCanvasElement
  setMode(mode: ViewportMode): void

  // Prepare
  setPlate(plate: ViewportPlate, opts?: { keepCamera?: boolean }): void
  /** Move objects without rebuilding geometry. */
  setTransforms(transforms: Record<string, number[]>): void
  setPartStyle(objectId: string, partIndex: number, style: PartStyle): void
  setRenderMode(mode: RenderMode): void
  setDisplayStyle(style: DisplayStyle): void
  /** Overhang heat map threshold in degrees from vertical. Amber starts 15 degrees below it. */
  setOverhangAngle(deg: number): void
  /**
   * sleipnir: draw the real layer heights on the models. `tops` are the top of every layer in mm,
   * ascending, first entry the first layer's top (core's options.layerTopsMm). The layer grooves follow
   * them, and with `band` (default true) a heat band colors thin layers blue and thick layers orange.
   * Null clears. Throws on tops that do not ascend. The shaders are shared by every viewport on the page.
   */
  setLayerHeights(tops: ArrayLike<number> | null, opts?: { band?: boolean }): void
  setLayerHeightBand(on: boolean): void
  /** Layer-groove shading in Prepare; `layerHeightMm` defaults to 0.2. */
  setPrintLook(on: boolean, layerHeightMm?: number): void
  /** The plate view draws the sliced toolpaths in place of the models; the hovered model turns solid. `stale` keeps the models solid until the next slice lands. */
  setToolpathLook(on: boolean, stale?: boolean): void
  setSelection(ids: string[]): void
  setTool(tool: PlateTool): void
  /** Brim ears per object, in bed coordinates (mm). `error` draws the ear in the alert color. */
  setBrimEars(ears: Record<string, { x: number; y: number; z: number; r: number; error?: boolean; selected?: boolean }[]>): void
  /** Radius of the faint disc that follows the cursor while the brim tool is on; null hides it. */
  setBrimHoverRadius(r: number | null): void
  /**
   * Fit check: a line between the closest points of two parts that sit too close. `on`: the objects it was measured
   * on and their transforms then; it follows one object as it moves and hides once either of two has moved. Empty clears them.
   */
  setGapLines(lines: readonly { from: [number, number, number]; to: [number, number, number]; kind: 'horizontal' | 'vertical' | 'fused' | 'apart'; on?: readonly { id: string; transform: readonly number[] }[] }[]): void
  /** Modeling guides in bed coordinates (mm): lines, closed outlines and end point dots. An empty object clears them. */
  setGuides(guides: Guides): void
  /** Probe tool: highlight the flat face under the cursor, as lay on face does. */
  setProbeFaces(on: boolean): void
  /** Probe tool: report the model point under the cursor as `probehover`, at most once a frame. Off by default. */
  setProbeHover(on: boolean): void
  /** Fillet and chamfer: the pieces the op would remove (red) and add (green), drawn through the model. Null clears them. */
  setEdgePreview(preview: EdgePreviewSpec | null): void
  /** Screen positions (CSS pixels from the canvas corner) of the scale handles of the selected model, or null when the scale tool is off. */
  scaleHandles(): Partial<Record<'xn' | 'xp' | 'yn' | 'yp' | 'zn' | 'zp' | 'cnn' | 'cpn' | 'cpp' | 'cnp', [number, number]>> | null
  /** Rotate tool: whether the rings turn the model about the bed's axes (`world`, the default) or its own (`local`). */
  setRotateSpace(space: 'world' | 'local'): void
  /** Screen positions (CSS pixels from the canvas corner) of a grab point on each rotate ring, or null when the rotate tool is off. */
  rotateHandles(): Partial<Record<'x' | 'y' | 'z', [number, number]>> | null
  /** Cut tool: shows the plane with its grabber and tilt rings on the model and clips the model there. Null ends it. */
  setCutPlane(cut: CutPlaneSpec | null): void
  /** Screen positions of the cut grabber and a point on each tilt ring, or null without a cut plane. */
  cutHandles(): { grabber: [number, number]; u: [number, number]; v: [number, number] } | null
  /**
   * Push and pull (with the probe tool): a press on a flat face and a drag move it along its normal, a
   * click picks it as usual. The view draws `prism` stretched to the distance. Null ends the tool.
   */
  setPush(push: PushSpec | null): void
  /** Sketch mode (with the probe tool): draws the sketch on its plane and reports the cursor there. Null ends it. */
  setSketch(scene: SketchScene | null): void
  /** The line being drawn and the snapped cursor. Cheap: call it on every hover event. */
  setSketchCursor(cursor: SketchCursor | null): void
  /** Turns the camera to look straight at a plane through `point` along `normal` (bed coordinates), framing `radiusMm`. */
  lookAtPlane(point: [number, number, number], normal: [number, number, number], radiusMm: number, opts?: { animate?: boolean }): void
  /** Kept dimensions: a line and a value label each, drawn through the model. An empty list clears them. */
  setDimensions(marks: readonly DimensionMark[]): void
  /** Paint tool options. Partial updates keep the rest. */
  setPaintSettings(settings: Partial<PaintSettings>): void
  getPaintSettings(): PaintSettings
  /** Filament slot colors for the color layer, slot 1 first (#rrggbb). */
  setPaintColors(colors: readonly string[]): void
  /**
   * Paint of one part as text per painted triangle (triangle index into the part's index buffer), the
   * same encoding as `paint_color`, `paint_seam` and `paint_supports` in 3MF.
   */
  getPaintData(objectId: string, partIndex: number, layer: PaintLayer): Record<number, string>
  /** Replaces the paint of a part. Null clears it. Malformed texts are skipped and their triangle indexes returned. */
  setPaintData(objectId: string, partIndex: number, layer: PaintLayer, texts: Record<number, string> | null): number[]
  /** Applies edits from a stroke (`after`) or an undo (`before`): null clears the triangle. */
  applyPaintEdits(objectId: string, partIndex: number, layer: PaintLayer, edits: readonly { triangle: number; text: string | null }[]): void
  /** Paints a bed height range in mm on every part of a model, `heightRangeMm` by default (the `height` tool paints a band at the cursor instead). */
  paintHeightRange(objectId: string, range?: [number, number]): void
  /** The gap fill tool's Perform button (Orca and Bambu Studio): patches smaller than `gapAreaMm2` merge into a neighbor. */
  performGapFill(objectId: string): void
  /** The flat face under a client-space point, or null. Works with any tool. */
  /** Model's face filter: light the face under the pointer outside a tool too. */
  setPickFaces?(on: boolean): void
  /** The faces picked in Model, drawn until changed: each the patch around a triangle. */
  setSelectedFaces?(faces: readonly { objectId: string; partIndex: number; triangle: number }[]): void
  pickFace(clientX: number, clientY: number): FacePick | null
  /** Packs objects on the bed and emits `transform` events. Returns the new transforms. */
  arrange(opts?: { animate?: boolean; gapMm?: number }): Record<string, number[]>
  view(preset: ViewPreset, opts?: { animate?: boolean }): void
  /** Frame the selection, or every model when nothing is selected. Animated by default. */
  zoomToSelection(opts?: { animate?: boolean }): void
  zoomToBed(opts?: { animate?: boolean }): void
  /** Moves the camera toward its target by `factor` (below 1 moves away), keeping the angle, within the zoom limits. */
  zoomBy(factor: number, opts?: { animate?: boolean }): void
  /** Eases the camera to center a bed point (mm) at the current angle and zoom; jumps under reduced motion. */
  focusBedPoint(x: number, y: number, z: number, opts?: { animate?: boolean }): void
  setProjection(projection: Projection): void
  getProjection(): Projection
  /** Switches and returns the new projection. */
  toggleProjection(): Projection
  /** Switch camera and mouse controls at runtime: a preset id or a full map. */
  /** Change scene colors at runtime. Omit to return to the defaults. Throws on an invalid color. */
  setTheme(theme?: ViewportTheme): void
  setControls(controls: ControlsPresetId | ControlsMap): void
  getControls(): ControlsMap
  getCamera(): CameraState
  setCamera(state: Partial<CameraState>, opts?: { animate?: boolean }): void

  // Preview
  setPreview(buffers: PreviewBuffers | null): void
  /** Dims the toolpaths while they no longer match the plate (a new slice is on its way), instead of hiding them. */
  setPreviewStale?(stale: boolean): void
  /** A second, faint set of toolpaths under the live one: the slice before a change. Null removes it. It follows the layer range. */
  setPreviewGhost(buffers: PreviewBuffers | null): void
  /** Where the plate's front left corner sits in the toolpaths' (machine) coordinates, mm: the preview is drawn shifted back by it. */
  setPreviewOrigin(x: number, y: number): void
  /** 0-based, inclusive layer indexes. */
  /** Reserves the bottom `px` of the view for an overlay (the playback bar). */
  setBottomInset(px: number): void
  /** Reserves the sides of the view that overlays cover, in pixels; views frame the model in the free area. */
  setInsets(insets: { left: number; right: number; top: number; bottom: number }): void
  /** Turns the bed outline orange (an object is off the bed). */
  setBedAlert(on: boolean): void
  /** Hides the bed for modeling: a plain ground grid at bed level, the camera and objects unchanged. */
  setGround(on: boolean): void
  /** Hatches the parts of the bed nothing may print on (polygons in bed coordinates, mm). An empty list clears them. */
  setExcludedAreas(areas: readonly (readonly [number, number])[][]): void
  /** Brightens one dual nozzle zone (by id); null resets. */
  setZoneHighlight(id: string | null): void
  setLayerRange(lo: number, hi: number): void
  /** Number of moves shown in the top layer of the range; null shows the whole layer. */
  setMoveCut(moves: number | null): void
  setColorMode(mode: ColorMode): void
  /** Filament colors by tool index, #rrggbb. */
  setToolColors(colors: string[]): void
  /** The finish each tool's filament prints with, tool 1 first (satin where none is given). The toolpaths shine to match. */
  setToolFinishes?(finishes: ToolpathFinish[]): void
  /** The bed under the print: `grid` (the default) or a build plate surface (textured or smooth PEI, cool, engineering). */
  setPlateStyle?(style: PlateStyle): void
  /** The printer family's toolhead for a printer with one nozzle (`headFor` maps a profile id to it). */
  setHeadModel(model: HeadModel): void
  /** The printer's tool changer: the toolhead, rack or dock Preview draws. Null draws the printer's own single head. */
  setToolChanger(spec: ToolChangerSpec | null): void
  /** Plays the tool change before `segment`, `seconds` into it (`fixed`: the firmware's seconds of it). Null returns the head to the current move. */
  setToolChange(c: { segment: number; seconds: number; fixed: number } | null): void
  /** Each tool change's purge at the chute, read from the G-code; the blob grows and drops while the change plays. Null for none. */
  setPurges?(plans: readonly PurgePlan[] | null): void
  /** Preview's "Show toolhead": false hides the moving head and its carriage; the rack, dock, chute and wiper stay and follow the print. */
  setShowToolhead?(on: boolean): void
  /** Preview's "Follow the nozzle": the camera moves with the head during playback, keeping its angle and zoom. */
  setFollowNozzle?(on: boolean): void
  setTravels(on: boolean): void
  /** Preview data beyond SXPV v1: fan, temperature, retraction and seam positions. Cleared by setPreview. */
  setPreviewExtras(extras: PreviewExtras | null): void
  /** Which extras are loaded, so an app can offer the fan and temperature schemes and the marker toggles. */
  previewExtras(): { fan: boolean; temperature: boolean } & Record<MarkerKind, boolean>
  /** Shows or hides each kind of marker. Markers follow the layer range. */
  setMarkers(opts: Partial<Record<MarkerKind, boolean>>): void
  /**
   * Wipe, tool change and pause positions read from the G-code (x, y, z per marker, bed frame mm; z on the layer
   * the marker belongs to). They keep until the next setPreview; null removes a kind.
   */
  setGcodeMarkers(data: Partial<Record<'wipes' | 'toolChanges' | 'pauses', Float32Array | null>>): void
  /** heimdall's strikes: where the machine would meet a printed part (bed frame, mm), drawn over everything. Null clears them. */
  setStrikes?(marks: readonly StrikeMark[] | null): void
  /** heimdall's gantry: the beam over the moving head (null for none), and the strikes it runs through a part on. */
  setGantry?(spec: GantrySpec | null, hits: readonly GantryHit[] | null): void
  /** Value ranges for legends of the speed, flow, width, height, fan and temperature schemes. */
  previewRanges(): PreviewRanges
  /** One row per feature type present: color, time, length and visibility. */
  previewLegend(): LegendFeature[]
  /** Show or hide a feature type in Preview. */
  setFeatureVisible(id: number, visible: boolean): void
  /** Show exactly these feature ids. */
  setVisibleFeatures(ids: readonly number[]): void
  /** The move at the nozzle (the last one drawn): segment, layer and G-code line, for a G-code line view. Null without a preview. */
  currentMove(): { segment: number; layer: number; gcodeLine: number } | null
  /** Number of moves in a layer, the range of the horizontal move slider. */
  layerMoveCount(layer: number): number

  on<E extends keyof ViewportEvents>(event: E, cb: (payload: ViewportEvents[E]) => void): () => void
  stats(): ViewportStats
  resetStats(): void
  /** Benchmarks and dev overlays: wait for the GPU after each frame so costMs holds the full frame cost. */
  setGpuTiming(on: boolean): void
  /** Request a frame. The viewport renders on demand and idles otherwise. */
  invalidate(): void
  dispose(): void
}
