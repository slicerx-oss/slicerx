// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/step-reader: STEP files (AP203, AP214, AP242) to meshes in millimeters, in a browser, a worker or Node.
// Node servers that read untrusted files use '@slicerx/step-reader/node', which reads each file in a worker thread
// with a deadline and memory cap.
export { stepInfo, toObj, toStl, type ObjOptions, type StepBounds, type StepInfo } from './convert.ts'
export { defaultWasmUrl, loadOcct, loadStepReader, type LoadOptions, type StepReader } from './load.ts'
export {
  readStep,
  STEP_ANGLE_RAD,
  STEP_ERROR_CODES,
  STEP_MAX_MB,
  STEP_MAX_TRIANGLES,
  STEP_TOLERANCE,
  StepError,
  stepUnit,
  toLocalOrigin,
  type Occt,
  type OcctMesh,
  type OcctParams,
  type OcctResult,
  type ReadOptions,
  type StepBody,
  type StepErrorCode,
  type StepQuality,
  type StepRead,
  type StepUnit,
} from './read.ts'
