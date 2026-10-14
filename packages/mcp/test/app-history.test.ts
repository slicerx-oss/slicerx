// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { appHistoryTools } from '../src/app-history'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

describe('project Undo and Redo commands', () => {
  it('serves history and resulting state to an MCP client, and preserves stale-edit errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-history-client-'))
    const state = { revision: 'project:2', undo: 1, redo: 0, activePlate: 'p1', plates: [{ id: 'p1', objects: [{ id: 'box', minMm: [20, 30, 0] }] }] }
    const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
      if (method !== 'history.get' && args['revision'] !== state.revision) throw Object.assign(new Error('History changed'), { code: 'busy' })
      return method === 'history.get' ? state : { ...state, changed: true, revision: 'project:3', undo: 0, redo: 1, plates: [{ id: 'p1', objects: [{ id: 'box', minMm: [0, 0, 0] }] }] }
    })
    const ctx = await createContext({ engine: 'sx', printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
    ctx.tools = appHistoryTools({ call } as AppLinkCaller, 'SlicerX')
    const server = createSlicerxServer(ctx)
    const client = new Client({ name: 'history-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(a), client.connect(b)])
      expect((await client.listTools()).tools.map((t) => t.name).filter((name) => name.startsWith('slicerx_app_')).sort()).toEqual(['slicerx_app_history', 'slicerx_app_redo', 'slicerx_app_undo'])
      expect(await client.callTool({ name: 'slicerx_app_history', arguments: {} })).toMatchObject({ structuredContent: { output: state } })
      expect(await client.callTool({ name: 'slicerx_app_undo', arguments: { revision: state.revision } })).toMatchObject({ structuredContent: { output: { changed: true, undo: 0, redo: 1, plates: [{ objects: [{ minMm: [0, 0, 0] }] }] } } })
      expect(await client.callTool({ name: 'slicerx_app_redo', arguments: { revision: 'old' } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
      expect(call).toHaveBeenLastCalledWith('history.redo', { revision: 'old' })
    } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('reaches every command from the CLI and stops the chain when the app is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-history-cli-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
    try {
      for (const tool of ['app_history', 'app_undo', 'app_redo']) {
        const args = tool === 'app_history' ? {} : { revision: 'project:1' }
        const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--printers', 'off', '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), 'call', tool, JSON.stringify(args), 'app_history'], { cwd: resolve(__dirname, '..'), env: { ...env, HOME: dir, USERPROFILE: dir } }).then(() => { throw new Error('Expected missing app') }, (e: unknown) => e as { code: number; stdout: string })
        expect(result.code).toBe(1)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ tool: `slicerx_${tool}`, ok: false, output: { error: { code: 'not_configured' } } })
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('requires a revision for edits, and preserves app-link permissions and failures', async () => {
    const tools = appHistoryTools(undefined, 'SlicerX')
    expect(tools.map((t) => t.permission)).toEqual(['read', 'slice', 'slice'])
    for (const args of [{}, { revision: 2 }, { revision: '' }, { revision: 'r', steps: 2 }]) expect(tools[1]!.input.safeParse(args).success).toBe(false)
    await expect(tools[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
    for (const [code, wanted] of [['app_closed', 'not_configured'], ['read_only', 'not_supported'], ['busy', 'busy'], ['invalid_input', 'invalid_input']]) {
      const call = async () => { throw Object.assign(new Error('refused'), { code }) }
      await expect(appHistoryTools({ call }, 'SlicerX')[1]!.run({ revision: 'r' } as never, {} as never)).rejects.toMatchObject({ code: wanted })
    }
  })
})
