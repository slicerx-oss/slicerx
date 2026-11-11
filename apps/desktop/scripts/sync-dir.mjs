// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Makes folder `to` hold what folder `from` holds, touching only what differs: a file is written when its bytes
// differ or it is new, a file or folder `from` lacks is removed, and every other file keeps its bytes and its
// modification time. cargo reruns the app's build script, and so recompiles the app, when a file in a folder it watches
// gets a newer time (tauri_build watches the bundle's resources), so a pack with nothing changed leaves no trace.
// Names in `keep` (at the top of `to`) are never removed, such as the .gitkeep that holds the folder in git.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {string} from
 * @param {string} to
 * @param {{ keep?: string[] }} [options]
 * @returns {{ written: string[], removed: string[], same: number }} paths relative to `to`, with forward slashes
 */
export function syncDir(from, to, { keep = [] } = {}) {
  const result = { written: [], removed: [], same: 0 }
  walk(from, to, '', new Set(keep), result)
  return result
}

function walk(from, to, rel, keep, result) {
  mkdirSync(to, { recursive: true })
  const wanted = new Map(readdirSync(from, { withFileTypes: true }).map((e) => [e.name, e.isDirectory()]))
  for (const e of readdirSync(to, { withFileTypes: true })) {
    if (rel === '' && keep.has(e.name)) continue
    const dir = wanted.get(e.name)
    // gone from `from`, or a file where a folder now is (or the other way round)
    if (dir === undefined || dir !== e.isDirectory()) {
      rmSync(join(to, e.name), { recursive: true, force: true })
      result.removed.push(rel + e.name)
    }
  }
  for (const [name, dir] of wanted) {
    const src = join(from, name)
    const dst = join(to, name)
    if (dir) {
      walk(src, dst, `${rel}${name}/`, keep, result)
      continue
    }
    const bytes = readFileSync(src)
    if (same(dst, bytes)) {
      result.same++
      continue
    }
    writeFileSync(dst, bytes)
    result.written.push(rel + name)
  }
}

function same(file, bytes) {
  try {
    return statSync(file).size === bytes.length && readFileSync(file).equals(bytes)
  } catch {
    return false
  }
}
