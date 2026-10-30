// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Measures the meshes the mesh-only host keeps (mesh-stats.ts) off the page's main thread.
import { answerMeshStats, type MeshStatsRequest } from './mesh-stats'

const scope = self as unknown as { onmessage: ((e: MessageEvent<MeshStatsRequest>) => void) | null; postMessage(m: unknown): void }
scope.onmessage = (e) => scope.postMessage(answerMeshStats(e.data))
