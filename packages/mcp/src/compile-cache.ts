// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Node's on-disk compile cache for the server's own code and its dependencies. A fresh process (each `sx call`, each
// client start) otherwise compiles every module again, which is most of its start time. The cache lives in the user's
// cache folder, never a shared temporary folder another account could write to. It is best effort: no cache folder,
// a read-only home or an older Node only skip it, and nothing here ever throws or writes to stdout or stderr, since
// stdout carries the MCP protocol.
import module from 'node:module'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** The folder the cache goes in by default, or undefined when this platform's cache folder can't be told. */
export function compileCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string | undefined): string | undefined {
  const { isAbsolute, join } = platform === 'win32' ? win32 : posix
  const usable = (dir: string | undefined): dir is string => !!dir && isAbsolute(dir)
  let root: string | undefined
  if (platform === 'win32') root = usable(env['LOCALAPPDATA']) ? env['LOCALAPPDATA'] : undefined
  else if (platform === 'darwin') root = usable(home) ? join(home, 'Library', 'Caches') : undefined
  else root = usable(env['XDG_CACHE_HOME']) ? env['XDG_CACHE_HOME'] : usable(home) ? join(home, '.cache') : undefined
  return root === undefined ? undefined : join(root, 'slicerx', 'node-compile-cache')
}

/**
 * Turns the compile cache on for the modules loaded after this call. NODE_COMPILE_CACHE, when set, has already turned
 * it on at Node's start in that folder, and NODE_DISABLE_COMPILE_CACHE keeps it off; both are left to Node.
 */
export function startCompileCache(env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (env['NODE_DISABLE_COMPILE_CACHE'] || env['NODE_COMPILE_CACHE']) return
    if (typeof module.enableCompileCache !== 'function') return
    const dir = compileCacheDir(env, process.platform, safeHome())
    if (dir === undefined) return
    // A folder that can't be made or written comes back as a failed status, not an error.
    module.enableCompileCache(dir)
  } catch {
    // the cache only saves time; a run without it is the same run
  }
}

/**
 * Writes what the cache holds so far. Node writes it when the process exits normally, but a stdio server is often
 * stopped by a signal, which skips that, so the entry also saves it once the server has started.
 */
export function saveCompileCache(): void {
  try {
    if (typeof module.flushCompileCache === 'function') module.flushCompileCache()
  } catch {
    // as above
  }
}

function safeHome(): string | undefined {
  try {
    return homedir()
  } catch {
    return undefined
  }
}
