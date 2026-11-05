// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The built entry turns Node's compile cache on (src/launch.ts). The cache only saves time: these start the entry over
// stdio, from source through tsx as sx-call.test.ts does, and check that a client gets the same answers, with nothing
// extra on stdout or stderr, whether the cache folder is writable, unwritable or turned off, and when several servers
// fill one empty cache at once. On Windows Node can leave a temporary file when two servers replace one entry at the
// same moment, and a later server removes it.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { compileCacheDir, ORPHAN_AGE_MS, removeOrphans } from '../src/compile-cache'

const pkg = resolve(__dirname, '..')
const entry = resolve(pkg, 'src/launch.ts')
const tsx = pathToFileURL(createRequire(resolve(pkg, 'package.json')).resolve('tsx/esm')).href
const win = process.platform === 'win32'
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) {
    try {
      chmodSync(join(dir, 'home', 'Library'), 0o700)
    } catch {
      // only some tests lock it
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-compile-cache-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'home'))
  return dir
}

/** The user cache folder of a test's home on every platform: macOS's own, and XDG_CACHE_HOME and LOCALAPPDATA here. */
const cacheRoot = (dir: string) => join(dir, 'home', 'Library', 'Caches')
const cacheDir = (dir: string) => join(cacheRoot(dir), 'slicerx', 'node-compile-cache')

function environment(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('SLICERX_') && !k.startsWith('NODE_') && k !== 'SX_TEST_HUB_PORT')) as Record<string, string>
  const home = join(dir, 'home')
  return { ...env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: cacheRoot(dir), LOCALAPPDATA: cacheRoot(dir), ...extra }
}

interface Answer {
  code: number | null
  stdout: string[]
  stderr: string
  tools: string
}

/** Starts the entry over stdio, asks for initialize and tools/list, then closes stdin, or with `stopAfter` waits that
 * many ms and stops it with SIGTERM, as a client often does. */
function start(dir: string, env: Record<string, string>, stopAfter?: number): Promise<Answer> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', tsx, entry, '--no-app', '--printers', 'off', '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let tools = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk
      for (const line of out.split('\n').slice(0, -1)) {
        const message = JSON.parse(line) as { id?: number; result?: unknown }
        if (message.id === 1 && !tools) {
          tools = JSON.stringify(message.result)
          if (stopAfter === undefined) child.stdin.end()
          else setTimeout(() => child.kill('SIGTERM'), stopAfter)
        }
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
    child.on('error', fail)
    child.on('close', (code) => done({ code, stdout: out.split('\n').filter(Boolean), stderr: err, tools }))
    for (const message of [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'compile-cache-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]) child.stdin.write(`${JSON.stringify(message)}\n`)
  })
}

/** The answer a client should see: two JSON-RPC replies on stdout and only the server's start line on stderr. */
function expectClean(answer: Answer): void {
  expect(answer.code).toBe(0)
  expect(answer.stdout).toHaveLength(2)
  for (const line of answer.stdout) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
  expect(answer.stderr).toMatch(/^slicerx-mcp [^\n]*\n$/)
  expect(JSON.parse(answer.tools).tools.length).toBeGreaterThan(100)
}

const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [])

describe('compile cache folder', () => {
  it('is in the user cache folder of each platform, and skipped when none can be told', () => {
    expect(compileCacheDir({}, 'darwin', '/Users/a')).toBe('/Users/a/Library/Caches/slicerx/node-compile-cache')
    expect(compileCacheDir({ XDG_CACHE_HOME: '/c' }, 'linux', '/home/a')).toBe('/c/slicerx/node-compile-cache')
    expect(compileCacheDir({}, 'linux', '/home/a')).toBe('/home/a/.cache/slicerx/node-compile-cache')
    expect(compileCacheDir({ XDG_CACHE_HOME: 'relative' }, 'linux', '/home/a')).toBe('/home/a/.cache/slicerx/node-compile-cache')
    expect(compileCacheDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Local\\slicerx\\node-compile-cache')
    expect(compileCacheDir({}, 'win32', 'C:\\Users\\a')).toBeUndefined()
    expect(compileCacheDir({}, 'linux', undefined)).toBeUndefined()
    expect(compileCacheDir({}, 'darwin', '')).toBeUndefined()
  })
})

describe('temporary files Node leaves in the cache', () => {
  it('are removed once they are old enough, and nothing else is', () => {
    const dir = temporary()
    const sub = join(dir, 'v24.0.0-x64-0123abcd')
    mkdirSync(sub)
    const now = Date.now()
    const old = new Date(now - ORPHAN_AGE_MS - 1000)
    const make = (name: string, when?: Date) => {
      writeFileSync(join(sub, name), 'x')
      if (when) utimesSync(join(sub, name), when, when)
    }
    make('45ebdb77', old) // an entry
    make('11118761.jpVfuU', old) // left behind
    make('0e20158e.FswFEk') // still being written
    make('notes.txt', old)
    make('45ebdb77.tmp', old)
    expect(removeOrphans(dir, now)).toBe(1)
    expect(readdirSync(sub).sort()).toEqual(['0e20158e.FswFEk', '45ebdb77', '45ebdb77.tmp', 'notes.txt'])
  })
})

describe('the entry with the compile cache', () => {
  it('fills the cache, and answers the same from it', async () => {
    const dir = temporary()
    const env = environment(dir)
    const first = await start(dir, env)
    expectClean(first)
    expect(files(cacheDir(dir)).length).toBeGreaterThan(0)
    const second = await start(dir, env)
    expectClean(second)
    expect(second.tools).toBe(first.tools)
  })

  it.skipIf(win)('saves the cache of a server that a client stops with a signal', async () => {
    const dir = temporary()
    const answer = await start(dir, environment(dir), 3000)
    expect(answer.stdout).toHaveLength(2)
    expect(files(cacheDir(dir)).length).toBeGreaterThan(0)
  })

  it('answers as usual when the cache folder sits under a file', async () => {
    const dir = temporary()
    writeFileSync(join(dir, 'home', 'Library'), 'not a folder')
    expectClean(await start(dir, environment(dir)))
  })

  it.skipIf(win || process.getuid?.() === 0)('answers as usual when the cache folder cannot be written', async () => {
    const dir = temporary()
    mkdirSync(join(dir, 'home', 'Library'))
    chmodSync(join(dir, 'home', 'Library'), 0o000)
    expectClean(await start(dir, environment(dir)))
  })

  it('writes nothing with NODE_DISABLE_COMPILE_CACHE, and uses NODE_COMPILE_CACHE when it is set', async () => {
    const dir = temporary()
    expectClean(await start(dir, environment(dir, { NODE_DISABLE_COMPILE_CACHE: '1' })))
    expect(files(cacheRoot(dir))).toEqual([])
    const chosen = join(dir, 'chosen')
    expectClean(await start(dir, environment(dir, { NODE_COMPILE_CACHE: chosen })))
    expect(files(cacheRoot(dir))).toEqual([])
    expect(files(chosen).length).toBeGreaterThan(0)
  })

  it('lets several servers fill one empty cache at once', async () => {
    const dir = temporary()
    const env = environment(dir)
    const all = await Promise.all(Array.from({ length: 6 }, () => start(dir, env)))
    for (const answer of all) expectClean(answer)
    expect(new Set(all.map((a) => a.tools)).size).toBe(1)
    const cached = files(cacheDir(dir))
    expect(cached.length).toBeGreaterThan(0)
    // Node writes each entry to <name>.XXXXXX and renames it into place. Elsewhere no temporary file is left behind.
    // On Windows the rename fails when another server replaces the same entry at that moment, so a few can be.
    const left = cached.filter((name) => name.includes('.'))
    if (!win) expect(left).toEqual([])
    for (const name of left) expect(name).toMatch(/^[0-9a-f]{8}\.[0-9A-Za-z]{6}$/)
    const after = await start(dir, env)
    expectClean(after)
    expect(after.tools).toBe(all[0]!.tools)
    if (!win) return
    // A server that runs past its save removes the ones old enough to be left behind for good.
    const long = new Date(Date.now() - ORPHAN_AGE_MS - 1000)
    for (const e of readdirSync(cacheDir(dir), { recursive: true, withFileTypes: true })) {
      if (e.isFile() && e.name.includes('.')) utimesSync(join(e.parentPath, e.name), long, long)
    }
    const stays = await start(dir, env, 3000)
    expect(stays.stdout).toHaveLength(2)
    expect(files(cacheDir(dir)).filter((name) => name.includes('.'))).toEqual([])
  })
})
