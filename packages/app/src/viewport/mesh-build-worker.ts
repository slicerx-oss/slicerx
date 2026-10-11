// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D view's mesh worker: big parts' creased normals and feature edges, off the main thread (viewport-host.tsx).
import { serveMeshBuilds } from '@slicerx/viewport/mesh-worker'

serveMeshBuilds(self as unknown as Parameters<typeof serveMeshBuilds>[0])
