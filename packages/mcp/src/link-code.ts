// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the server gets sx-link's agent code. Never from the command line, which every local user
// can read with ps: from SLICERX_MCP_LINK_CODE, or from the hub's state directory, where sx-link
// writes it with mode 0600.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** sx-link's default state directory, as `default_state_dir` in packages/connect/link/src/lib.rs. */
export function hubStateDir(): string | undefined {
  const home = process.env['HOME'] || homedir()
  if (process.platform === 'darwin') return home ? join(home, 'Library/Application Support/SlicerX/hub') : undefined
  if (process.platform === 'win32') return process.env['APPDATA'] ? join(process.env['APPDATA'], 'SlicerX', 'hub') : undefined
  if (process.env['XDG_STATE_HOME']) return join(process.env['XDG_STATE_HOME'], 'slicerx/hub')
  return home ? join(home, '.local/state/slicerx/hub') : undefined
}

/** The running hub's agent code from its state directory. Refuses a file other users can read. */
export function readAgentCode(dir: string | undefined): string | undefined {
  const at = dir ?? hubStateDir()
  if (!at) return undefined
  const file = join(at, 'agent-code')
  try {
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) throw new Error(`${file} is readable by other users; sx-link writes it with mode 0600. Fix its mode or restart sx-link.`)
    return readFileSync(file, 'utf8').trim() || undefined
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/** The hub's public key (`hub-key.pub`), so the client can check the hub before sending the code. */
export function readHubKey(dir: string | undefined): string | undefined {
  const at = dir ?? hubStateDir()
  if (!at) return undefined
  try {
    return readFileSync(join(at, 'hub-key.pub'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** The agent code for `--printers link`. Throws for a code given on the command line. */
export function linkCodeFrom(o: { argvCode: string | undefined; stateDir: string | undefined; envCode: string | undefined; needed: boolean }): string | undefined {
  if (o.argvCode !== undefined) throw new Error("--link-code is no longer accepted, since other users can read command lines. The server reads the hub's agent code from its state directory (sx-link code --agent shows it), or set SLICERX_MCP_LINK_CODE.")
  if (o.envCode) return o.envCode
  return o.needed ? readAgentCode(o.stateDir) : undefined
}

/**
 * A client's own hub credential from the OS keychain, by the item name its config gives
 * (`SLICERX_MCP_LINK_KEY_REF`, account `slicerx`). The "Connect your AI agent" panel stores it
 * there, so no client's config file ever holds a secret. macOS and Linux (Secret Service).
 */
export function readKeychainKey(ref: string, run: (cmd: string, args: string[]) => string = (c, a) => execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })): string {
  if (!/^slicerx-agent-[a-z-]+$/.test(ref)) throw new Error(`${ref} is not a SlicerX agent credential name`)
  let out = ''
  try {
    if (process.platform === 'darwin') out = run('security', ['find-generic-password', '-s', ref, '-a', 'slicerx', '-w'])
    // The desktop app writes with the keyring crate, whose Secret Service items carry `service` and `username`.
    else if (process.platform === 'linux') out = run('secret-tool', ['lookup', 'service', ref, 'username', 'slicerx'])
    else throw new Error('reading the keychain is not supported on this system yet')
  } catch (e) {
    if (e instanceof Error && e.message.includes('not supported')) throw e
    throw new Error(`No hub credential in the keychain under ${ref}. Connect this app again from SlicerX (Settings, Connect your AI agent).`)
  }
  const key = out.trim()
  if (!key) throw new Error(`The keychain item ${ref} is empty. Connect this app again from SlicerX.`)
  return key
}

/**
 * A partner app's hub key from `SLICERX_MCP_LINK_KEY`: `sxp_` and 64 hex digits, made in SlicerX
 * (Connect your AI agent, Partner app). The message on a bad key never repeats it.
 */
export function linkKeyFrom(key: string): string {
  const k = key.trim()
  if (!/^sxp_[0-9a-f]{64}$/.test(k)) throw new Error('SLICERX_MCP_LINK_KEY is not a SlicerX partner app key. Make one in SlicerX (Settings, Connect your AI agent, Partner app) and paste it whole.')
  return k
}
