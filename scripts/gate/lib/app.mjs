// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Starts a bridge build of the desktop app for a gate run, connects the running-app MCP server (packages/app-bridge)
// to it over stdio, and stops the app by its process id. The same on Windows, macOS and Linux. The connection file
// with the per-run token lives in a temporary folder, never in the report folder, and goes when the run ends.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sleep } from './util.mjs'

export const repo = resolve(import.meta.dirname, '../../..')
const win = process.platform === 'win32'

/** The executable to start: the path given, or inside a macOS .app bundle its Contents/MacOS program. */
export function appExecutable(app) {
  const p = resolve(app)
  if (p.endsWith('.app') && existsSync(p) && statSync(p).isDirectory()) {
    const dir = join(p, 'Contents', 'MacOS')
    const names = readdirSync(dir)
    const main = names.find((n) => n === 'slicerx') ?? names[0]
    if (!main) throw new Error(`${p} has no program in Contents/MacOS`)
    return join(dir, main)
  }
  return p
}

/** How many processes run this exact executable. The app is single-instance, so a running copy would take our launch over. */
export function runningCopies(exe) {
  if (win) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' }).Count`], { encoding: 'utf8' })
    return Number(r.stdout.trim()) || 0
  }
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return (r.stdout ?? '').split('\n').filter((l) => l.trim().split(/\s+/)[1] === exe).length
}

/**
 * Starts the app with the bridge on a free port and a fresh web profile (unless `profile` names one to reuse), and
 * waits for its connection file. Returns { pid, tokenFile, stop, stderr }.
 */
export async function startApp({ app, profile, log }) {
  const exe = appExecutable(app)
  if (!existsSync(exe)) throw new Error(`no app at ${exe}; build it with pnpm --filter @slicerx/desktop build:bridge`)
  if (runningCopies(exe) > 0) throw new Error(`${exe} is already running; quit it first (the app is single-instance)`)
  const work = mkdtempSync(join(tmpdir(), 'sx-gate-'))
  const tokenFile = join(work, 'agent-bridge.json')
  const env = { ...process.env, SX_AGENT_BRIDGE_PORT: '0', SX_AGENT_BRIDGE_TOKEN_FILE: tokenFile }
  const fresh = profile ? resolve(profile) : join(work, 'profile')
  // A fresh profile shows first run and reads nothing of anyone's own app state. Windows keeps the web profile where
  // WEBVIEW2_USER_DATA_FOLDER says; Linux keeps the app's data and WebKitGTK's under the XDG folders. macOS has no
  // such switch: there the bridge build's own data folder is used as it is (docs/release-gate.md).
  if (win) env.WEBVIEW2_USER_DATA_FOLDER = join(fresh, 'webview2')
  else if (process.platform === 'linux') {
    env.XDG_DATA_HOME = join(fresh, 'data')
    env.XDG_CONFIG_HOME = join(fresh, 'config')
    env.XDG_CACHE_HOME = join(fresh, 'cache')
  }
  const child = spawn(exe, [], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: false })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-8000)))
  log?.(`started ${exe} as pid ${child.pid}`)
  for (let i = 0; i < 240 && !existsSync(tokenFile) && child.exitCode === null; i++) await sleep(250)
  const stop = async () => {
    // Stopped by its own process id, never by name.
    if (child.exitCode === null && child.signalCode === null) {
      if (win) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else {
        child.kill('SIGTERM')
        for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(250)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }
    for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(250)
    const stopped = child.exitCode !== null || child.signalCode !== null
    rmSync(tokenFile, { force: true })
    if (!profile) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    return stopped
  }
  if (!existsSync(tokenFile)) {
    await stop()
    throw new Error(`the app wrote no connection file (exit ${child.exitCode}); its last output: ${stderr.slice(-400)}`)
  }
  return { pid: child.pid, exe, tokenFile, stop, stderr: () => stderr }
}

/** The MCP SDK as packages/app-bridge resolves it, so the gate adds no dependency of its own. */
async function sdk() {
  const require = createRequire(join(repo, 'packages', 'app-bridge', 'package.json'))
  const load = (p) => import(pathToFileURL(require.resolve(p)).href)
  const [client, stdio] = await Promise.all([load('@modelcontextprotocol/sdk/client/index.js'), load('@modelcontextprotocol/sdk/client/stdio.js')])
  return { Client: client.Client, StdioClientTransport: stdio.StdioClientTransport }
}

/**
 * Connects the running-app MCP server to the app whose connection file is `tokenFile`. `call(tool, args)` resolves
 * to { data, error, content }; it never throws for a tool's own error.
 */
export async function connectBridge(tokenFile) {
  const { Client, StdioClientTransport } = await sdk()
  const client = new Client({ name: 'slicerx-release-gate', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'packages', 'app-bridge', 'src', 'cli.ts'), '--token-file', tokenFile], stderr: 'ignore' }))
  const call = async (name, args = {}) => {
    // The app gives a call its own timeoutMs; the request waits a minute longer than that.
    const own = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000
    try {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: own + 60_000 })
      return { data: r.structuredContent ?? null, error: r.isError ? String(r.content?.[0]?.text ?? 'error') : null, content: r.content }
    } catch (e) {
      return { data: null, error: `Error: client: ${e instanceof Error ? e.message : String(e)}`, content: [] }
    }
  }
  const { tools } = await client.listTools()
  return { call, tools: tools.map((t) => t.name), close: () => client.close().catch(() => undefined) }
}
