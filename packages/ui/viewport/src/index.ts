// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/viewport: the SlicerX 3D viewport. Framework free; see README.md.
export { createViewport } from './viewport'
// The SXPV reader, so a page can load a .sxpv file (from sx slice --request --out-dir) with this package alone.
export { readPreview, type PreviewBuffers } from '@slicerx/contracts'
export { decodeTree, encodeTree, paintTexts, readPaintTexts, leavesOf, type PaintNode, type PaintMap } from './paint'
export { layerCoordAt, layerHeightStats, layerThicknesses, layerTopsProblems } from './layerheights'
export { facePatch, layOnFaceTransform, rotationBetween } from './faces'
export { summarizePreview, type PreviewSummary } from './summary'
export { ChangeClock, changeSequence, moveDistance, moveTime, poseAt, rackStateBefore, toolChangerSpec, type ChangeSequence, type Phase, type Pose, type ToolChangerKind, type ToolChangerSpec } from './toolchanger'
export { CHUTE, blobAt, blobShape, flushOf, flushedShare, meshVolume, purgeFromTools, purgeGrams, purgeVolume, purgeWindow, totalSeconds, type BlobState, type Flush, type FlushStep, type PurgePlan, type PurgeWindow } from './purge'
export { changePoints } from './toolpaths'
export { HEAD_MODELS, headFor, type HeadModel } from './heads'
export type { StrikeMark } from './strikes'
export { COLORBLIND_THEME, FEATURE_COLORS, HEAT_RAMP, DEFAULT_TOOL_COLORS, SCENE, resolveTheme, themeProblems, type FeatureStyle, type SceneColors, type ViewportTheme } from './palette'
export { applyInsets, freeArea, NO_INSETS, type Insets } from './camera'
export type * from './types'
export type { ProbeStats, Spread } from './probe'
export type { Guides, GuidePoint } from './guides'
export { fromPlane, prismMatrix, rayOnPlane, toPlane, type CadFrame, type DimensionMark, type SketchCursor, type SketchScene, type SketchTone, type V2 } from './cadtools'
export { CONTROL_PRESETS, CONTROL_PRESET_IDS, controlsPreset, resolveDrag, resolveWheel, withRemap, withGizmo, type ButtonRemap, type ControlsContext, type ControlsMap, type ControlsPresetId, type DragAction, type DragBinding } from './controls'
export { angleAround, ringAxes, rotateAbout, snapAngle, unwrapAngle, type RingAxis, type RotateSpace } from './rings'
export { BAMBU_GIZMO, ORCA_GIZMO, PRUSA_GIZMO, withGizmoOverrides, type GizmoBindings, type GizmoOverrides, type ModKey, type RotateBindings } from './gizmobindings'
