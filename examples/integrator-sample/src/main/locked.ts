// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Locked projects (.sxlock) without the server, as in docs/integrators/quickstart.md.
import { openSxlock, readSxlockHeader, sealSxlock, SxlockError, SXLOCK_MESSAGES, tokenKeys } from '@slicerx/embed/sxlock'

export interface Account {
  supabaseUrl: string
  anonKey: string
  /** An sxk_ token with sxlock_open and sxlock_seal. */
  token: string
}

/** The account from the environment, or null when no token is configured. */
export function accountFromEnv(env: NodeJS.ProcessEnv = process.env): Account | null {
  const token = env['SLICERX_MCP_SXLOCK_TOKEN']
  const supabaseUrl = env['SLICERX_MCP_SUPABASE_URL']
  const anonKey = env['SLICERX_MCP_SUPABASE_ANON_KEY']
  return token && supabaseUrl && anonKey ? { token, supabaseUrl, anonKey } : null
}

/** Locks a project for the account and opens it again; returns the owner and whether the bytes came back the same. */
export async function lockAndOpen(sx3mf: Uint8Array, account: Account): Promise<{ owner: string; same: boolean; locked: Uint8Array; opened: Uint8Array }> {
  const keys = tokenKeys(account)
  const locked = await sealSxlock(sx3mf, keys)
  const header = readSxlockHeader(locked)
  const opened = await openSxlock(locked, keys)
  const same = opened.length === sx3mf.length && opened.every((b, i) => b === sx3mf[i])
  return { owner: header.owner, same, locked, opened }
}

/** What a file that is not locked gives: the error code and the sentence to show. */
export function notLocked(bytes: Uint8Array): { code: string; message: string } | null {
  try {
    readSxlockHeader(bytes)
    return null
  } catch (e) {
    if (e instanceof SxlockError) return { code: e.code, message: SXLOCK_MESSAGES[e.code] }
    throw e
  }
}
