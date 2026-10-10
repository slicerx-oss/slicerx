// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads 3MF projects and big binary STLs off the main thread (project-scan.ts, stl-scan.ts): the file comes in
// transferred, the meshes go back as transferred typed arrays. It also writes the autosave's project file
// (threemf.ts): the project comes in with its meshes transferred, and the file goes back transferred.
import { scanFailure, scanProject, transferables } from './project-scan'
import { scanStl } from './stl-scan'
import type { ProjectInput } from './threemf'

self.onmessage = async (e: MessageEvent<{ id: number; data: ArrayBuffer } | { id: number; stl: ArrayBuffer } | { id: number; write: ProjectInput }>) => {
  const msg = e.data
  try {
    if ('write' in msg) {
      // Loaded the first time a project is written, so reading files does not wait for the writer's code.
      const result = await (await import('./threemf')).writeProjectCompressed(msg.write)
      self.postMessage({ id: msg.id, result }, { transfer: [result.buffer] })
      return
    }
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
