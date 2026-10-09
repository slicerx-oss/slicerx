// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads 3MF projects off the main thread (project-scan.ts): the archive comes in transferred, the meshes go back as
// transferred typed arrays.
import { scanFailure, scanProject, transferables } from './project-scan'

self.onmessage = async (e: MessageEvent<{ id: number; data: ArrayBuffer }>) => {
  const { id, data } = e.data
  try {
    const result = await scanProject(new Uint8Array(data))
    self.postMessage({ id, result }, { transfer: transferables(result) })
  } catch (err) {
    self.postMessage({ id, ...scanFailure(err) })
  }
}
