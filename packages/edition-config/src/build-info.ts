// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which commit a build is made from, for the About screen. Node-only; import from '@slicerx/edition-config/node'.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const HASH = /^[0-9a-f]{7,40}$/i

/** Where a commit can come from, in the order they are tried. Each returns null when it has nothing. */
export interface CommitSources {
  /** `SLICERX_COMMIT`, for builds made from a copy of the tree (a tarball, a CI checkout without .git). */
  env: string | null
  git: () => string | null
  /** A `BUILD_COMMIT` file at the tree's root, written when the tree was copied. */
  file: () => string | null
  /** The dev server, which may say `dev`. A production build may not. */
  serve: boolean
}

/**
 * The commit to embed. A production build that cannot find one fails, so a release never says `dev`;
 * only the dev server falls back to it. `SLICERX_COMMIT=dev` asks for that on purpose.
 */
export function resolveCommit(src: CommitSources): string {
  const named = src.env?.trim()
  if (named) {
    if (named === 'dev' || HASH.test(named)) return named
    throw new Error(`SLICERX_COMMIT must be a git commit hash, got "${named}".`)
  }
  for (const find of [src.git, src.file]) {
    const v = find()?.trim()
    if (v && HASH.test(v)) return v
  }
  if (src.serve) return 'dev'
  throw new Error('This build has no git commit to embed: there is no .git folder and no BUILD_COMMIT file. Set SLICERX_COMMIT to the commit hash (or to "dev" for a local build).')
}

/** The commit of the tree at `root`, from the environment, git, or its BUILD_COMMIT file. */
export function buildCommit(root: string, serve: boolean, env: Record<string, string | undefined> = process.env): string {
  return resolveCommit({
    env: env['SLICERX_COMMIT'] ?? null,
    git: () => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return null
      }
    },
    file: () => (existsSync(join(root, 'BUILD_COMMIT')) ? readFileSync(join(root, 'BUILD_COMMIT'), 'utf8') : null),
    serve,
  })
}
