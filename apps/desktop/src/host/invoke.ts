// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every shell command the page calls goes through here, so a crash report of a rejection with no stack can name the
// command that failed last. Only the command's name is kept, never its arguments or what it answered.
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core'

let lastFailed: string | null = null

/** The name of the last shell command that rejected, or null when none has. */
export function lastFailedCommand(): string | null {
  return lastFailed
}

/** `call` with its rejections recorded under `command` (a path lookup from the API's own modules, say). */
export function tracked<A extends unknown[], T>(command: string, call: (...a: A) => Promise<T>): (...a: A) => Promise<T> {
  return async (...a: A) => {
    try {
      return await call(...a)
    } catch (e) {
      lastFailed = command
      throw e
    }
  }
}

/** The shell's invoke, recording the command's name when it rejects. */
export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  return tracked(cmd, () => tauriInvoke<T>(cmd, args, options))()
}
