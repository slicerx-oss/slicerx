// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fillet and chamfer engine calls the edge tool uses (docs/cad-fillet.md): edge.pick, edge.fillet
// and edge.chamfer with their previews, and the sketch corner ops. They live in geom/cad.ts with the
// other engine calls; this file keeps the tool's import path.
export { chamferSketch, edgeOp, edgePreview, filletSketch, pickEdge } from '../geom/cad'
export type { EdgeFace, EdgePick, EdgeProfile, EdgeRef, EdgeRequest, EdgeResult, SketchCorner, SketchCornerResult } from '../geom/cad'
