// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads 3MF projects and big binary STLs off the main thread (project-scan.ts, stl-scan.ts): the file comes in
// transferred, the meshes go back as transferred typed arrays.
import { scanFailure, scanProject, transferables } from './project-scan'
import { scanStl } from './stl-scan'

self.onmessage = async (e: MessageEvent<{ id: number; data: ArrayBuffer } | { id: number; stl: ArrayBuffer }>) => {
  const msg = e.data
  try {
    if ('stl' in msg) {
      const result = scanStl(new Uint8Array(msg.stl))
      self.postMessage({ id: msg.id, result }, { transfer: result ? [result.positions.buffer, result.indices.buffer] : [] })
      return
    }
    const result = await scanProject(new Uint8Array(msg.data))
    self.postMessage({ id: msg.id, result }, { transfer: transferables(result) })
  } catch (err) {
    self.postMessage({ id: msg.id, ...scanFailure(err) })
  }
}
