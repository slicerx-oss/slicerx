// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the running app's bridge listens and its token: the connection file the app writes at start
// (apps/desktop/src-tauri/src/agent_bridge). SX_AGENT_BRIDGE_TOKEN_FILE names it, the same variable the app reads;
// otherwise it is agent-bridge.json in the app's data folder, which Tauri names after the app's identifier: a bridge
// build's own (app.slicerx.desktop.agent-bridge, from build:bridge) or the plain one (a dev run), the newer file first.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_IDENTIFIER = 'app.slicerx.desktop'
/** What build:bridge adds to the identifier (apps/desktop/scripts/bridge-build.mjs). */
export const BRIDGE_SUFFIX = '.agent-bridge'
export const FILE_NAME = 'agent-bridge.json'

export interface Connection {
  port: number
  token: string
  pid: number
  app?: string
  version?: string
}

/** The app's data folder as Tauri's app_data_dir resolves it on each platform. */
export function appDataDir(identifier: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'win32') return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), identifier)
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', identifier)
  return join(env['XDG_DATA_HOME'] || join(home, '.local', 'share'), identifier)
}

/**
 * Where to look for the connection file: the explicit path, else SX_AGENT_BRIDGE_TOKEN_FILE, else the data folders of
 * the bridge build's identifier and the plain one (`--identifier` or SX_AGENT_BRIDGE_APP_ID names another edition's).
 */
export function connectionFiles(opts: { file?: string | undefined; identifier?: string | undefined } = {}, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  const named = opts.file || env['SX_AGENT_BRIDGE_TOKEN_FILE']
  if (named) return [named]
  const id = opts.identifier || env['SX_AGENT_BRIDGE_APP_ID'] || DEFAULT_IDENTIFIER
  const ids = id.endsWith(BRIDGE_SUFFIX) ? [id] : [`${id}${BRIDGE_SUFFIX}`, id]
  return ids.map((i) => join(appDataDir(i, platform, env, home), FILE_NAME))
}

/** Of the places to look, the file written last; the first place when none exists yet. */
export function newestFile(files: readonly string[]): string {
  let best: { file: string; at: number } | null = null
  for (const file of files) {
    try {
      const at = statSync(file).mtimeMs
      if (!best || at > best.at) best = { file, at }
    } catch {
      // Not there.
    }
  }
  return best?.file ?? files[0] ?? FILE_NAME
}

export class NotRunning extends Error {}

/** Reads the connection file the app wrote this run. */
export function readConnection(file: string): Connection {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new NotRunning(`No running app with the agent bridge: ${file} does not exist. Start a bridge build with SX_AGENT_BRIDGE_PORT set (docs/agent-bridge.md).`)
  }
  let v: Partial<Connection>
  try {
    v = JSON.parse(text) as Partial<Connection>
  } catch {
    throw new NotRunning(`${file} is not the bridge's connection file.`)
  }
  if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port <= 0 || v.port > 65_535 || typeof v.token !== 'string' || v.token.length < 32) {
    throw new NotRunning(`${file} does not name a port and token.`)
  }
  return { port: v.port, token: v.token, pid: typeof v.pid === 'number' ? v.pid : 0, ...(v.app ? { app: v.app } : {}), ...(v.version ? { version: v.version } : {}) }
}
