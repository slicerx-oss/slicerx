// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Node's on-disk compile cache for the server's own code and its dependencies. A fresh process (each `sx call`, each
// client start) otherwise compiles every module again, which is most of its start time. The cache lives in the user's
// cache folder, never a shared temporary folder another account could write to. It is best effort: no cache folder,
// a read-only home or an older Node only skip it, and nothing here ever throws or writes to stdout or stderr, since
// stdout carries the MCP protocol.
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import module from 'node:module'
import { homedir } from 'node:os'
import { join as joinPath, posix, win32 } from 'node:path'

/** The folder name of the stock build; a white-label edition uses its own id (the edition config's `id`). */
const STOCK_NAME = 'slicerx'
/** What the edition config allows for `id`: it is safe as a folder name on every platform. */
const EDITION_ID = /^[a-z][a-z0-9-]{1,31}$/

/**
 * The id of the edition this server runs for, read from the resolved edition config SLICERX_CONFIG names, the same
 * file the server reads for the edition's name. No config, an unreadable one or an id that is not a valid edition id
 * gives the stock name. A stock start has no config, so it reads nothing before the cache is on.
 */
export function editionCacheName(env: NodeJS.ProcessEnv): string {
  const path = env['SLICERX_CONFIG']
  if (!path) return STOCK_NAME
  try {
    const id = (JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown }).id
    return typeof id === 'string' && EDITION_ID.test(id) ? id : STOCK_NAME
  } catch {
    return STOCK_NAME
  }
}

/** The folder the cache goes in by default, or undefined when this platform's cache folder can't be told. */
export function compileCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string | undefined, name = STOCK_NAME): string | undefined {
  const { isAbsolute, join } = platform === 'win32' ? win32 : posix
  const usable = (dir: string | undefined): dir is string => !!dir && isAbsolute(dir)
  let root: string | undefined
  if (platform === 'win32') root = usable(env['LOCALAPPDATA']) ? env['LOCALAPPDATA'] : undefined
  else if (platform === 'darwin') root = usable(home) ? join(home, 'Library', 'Caches') : undefined
  else root = usable(env['XDG_CACHE_HOME']) ? env['XDG_CACHE_HOME'] : usable(home) ? join(home, '.cache') : undefined
  return root === undefined ? undefined : join(root, name, 'node-compile-cache')
}

/**
 * Turns the compile cache on for the modules loaded after this call. NODE_COMPILE_CACHE, when set, has already turned
 * it on at Node's start in that folder, and NODE_DISABLE_COMPILE_CACHE keeps it off; both are left to Node.
 */
export function startCompileCache(env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (env['NODE_DISABLE_COMPILE_CACHE'] || env['NODE_COMPILE_CACHE']) return
    if (typeof module.enableCompileCache !== 'function') return
    const dir = compileCacheDir(env, process.platform, safeHome(), editionCacheName(env))
    if (dir === undefined) return
    // A folder that can't be made or written comes back as a failed status, not an error.
    module.enableCompileCache(dir)
  } catch {
    // the cache only saves time; a run without it is the same run
  }
}

/**
 * Writes what the cache holds so far. Node writes it when the process exits normally, but a stdio server is often
 * stopped by a signal, which skips that, so the entry also saves it once the server has started. On Windows it then
 * removes the temporary files Node left behind (`removeOrphans`).
 */
export function saveCompileCache(): void {
  try {
    if (typeof module.flushCompileCache === 'function') module.flushCompileCache()
    const dir = typeof module.getCompileCacheDir === 'function' ? module.getCompileCacheDir() : undefined
    if (process.platform === 'win32' && dir) removeOrphans(dir)
  } catch {
    // as above
  }
}

/**
 * Node writes each cache entry to a temporary file, `<entry>.XXXXXX`, and renames it over the entry. On Windows the
 * rename fails with EPERM when another server is replacing the same entry at that moment, which happens when several
 * clients start servers on an empty or outdated cache, and Node then leaves the temporary file behind. Each such
 * start would leave more of them in the user's cache folder, so this removes the ones old enough that no writer can
 * still be about to rename them. Returns how many it removed.
 */
export function removeOrphans(dir: string, now = Date.now()): number {
  let removed = 0
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !ORPHAN_NAME.test(entry.name)) continue
    const file = joinPath(entry.parentPath, entry.name)
    try {
      if (now - statSync(file).mtimeMs < ORPHAN_AGE_MS) continue
      unlinkSync(file)
      removed++
    } catch {
      // gone already, or still open: the next server removes it
    }
  }
  return removed
}

/** A cache entry's name is 8 hex digits; Node's temporary file adds a dot and 6 random characters. */
const ORPHAN_NAME = /^[0-9a-f]{8}\.[0-9A-Za-z]{6}$/
/** Node renames a temporary file right after writing it, so one a minute old has been left behind. */
export const ORPHAN_AGE_MS = 60_000

function safeHome(): string | undefined {
  try {
    return homedir()
  } catch {
    return undefined
  }
}
