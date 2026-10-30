// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The embedded view's mesh worker: big parts' creased normals and feature edges, made off the host page's main thread
// (mesh-workers.ts starts it). The host's bundler finds it next to the view through `new URL(..., import.meta.url)`.
import { serveMeshBuilds, type MeshWorkerScope } from '@slicerx/viewport/mesh-worker'

serveMeshBuilds(self as unknown as MeshWorkerScope)
