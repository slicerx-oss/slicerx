// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The standalone build (build.mjs --standalone) is what the desktop app ships as Resources/mcp and packs into the
// .mcpb for Claude Desktop. Its entry, slicerx-mcp.mjs, turns on the compile cache and loads the server from
// slicerx-mcp-main.mjs beside it, so a packager has to carry the whole folder. This builds it, copies the folder the
// way those packagers do, and starts the copied entry with nothing else around it: no node_modules, a bare PATH.
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const pkg = resolve(__dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'sx-standalone-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function toolsList(entry: string, home: string): Promise<{ code: number | null; tools: number; stderr: string }> {
  return new Promise((done, fail) => {
    const env = { PATH: process.platform === 'win32' ? (process.env['PATH'] ?? '') : '/usr/bin:/bin', HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'cache'), SYSTEMROOT: process.env['SYSTEMROOT'] ?? '' }
    const child = spawn(process.execPath, [entry, '--no-app', '--printers', 'off', '--out-dir', join(home, 'out'), '--profiles-dir', join(home, 'profiles')], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let tools = -1
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk
      for (const line of out.split('\n').slice(0, -1)) {
        const message = JSON.parse(line) as { id?: number; result?: { tools: unknown[] } }
        if (message.id === 1 && tools < 0) {
          tools = message.result?.tools.length ?? 0
          child.stdin.end()
        }
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
    child.on('error', fail)
    child.on('close', (code) => done({ code, tools, stderr: err }))
    for (const message of [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'standalone-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]) child.stdin.write(`${JSON.stringify(message)}\n`)
  })
}

describe('the standalone build', () => {
  it('runs from a copy of its folder, the way the app and the .mcpb carry it', async () => {
    const built = join(work, 'built')
    execFileSync(process.execPath, [join(pkg, 'scripts', 'build.mjs'), '--standalone', built], { stdio: 'pipe', timeout: 120_000 })
    expect(existsSync(join(built, 'slicerx-mcp.mjs'))).toBe(true)
    expect(existsSync(join(built, 'slicerx-mcp-main.mjs'))).toBe(true)
    const shipped = join(work, 'Resources', 'mcp')
    cpSync(built, shipped, { recursive: true })
    rmSync(built, { recursive: true, force: true })
    const answer = await toolsList(join(shipped, 'slicerx-mcp.mjs'), mkdtempSync(join(work, 'home-')))
    expect(answer.code).toBe(0)
    expect(answer.tools).toBeGreaterThan(100)
    expect(answer.stderr).toMatch(/^slicerx-mcp [^\n]*\n$/)
  })
})
