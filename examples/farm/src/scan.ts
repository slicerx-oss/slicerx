// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which models in a folder need slicing: new ones, and ones changed since their last result.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isModel, jobName } from './slice.ts'

export interface Job {
  model: string
  name: string
  outDir: string
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

/** Models directly in `inDir` (not in subfolders), sorted by name, with their output folders. */
export async function listJobs(inDir: string, outDir: string): Promise<Job[]> {
  const names = (await readdir(inDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && isModel(e.name))
    .map((e) => e.name)
    .sort()
  return names.map((n) => ({ model: join(inDir, n), name: jobName(n), outDir: join(outDir, jobName(n)) }))
}

/** True when the model has no result yet or was changed after its result was written. */
export async function isStale(job: Job): Promise<boolean> {
  const model = await mtime(job.model)
  const result = await mtime(join(job.outDir, 'result.json'))
  return model !== null && (result === null || model > result)
}
