// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { setAssistantBrand, setAssistantName } from '@slicerx/contracts'
import { appAssistantTools } from '../src/app-assistant'
import type { AppLinkCaller } from '../src/app-route'
import { editionAssistantFromEnv } from '../src/edition'
import { connect } from './helpers'

afterEach(() => setAssistantBrand())

it('loads the assistant name for CLI help without changing command flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-cli-'))
  try {
    const file = join(dir, 'edition.json')
    writeFileSync(file, JSON.stringify({ brand: { name: 'LayerMate', assistant: { name: 'yourmate' } } }))
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'], {
      cwd: resolve(__dirname, '..'), env: { ...process.env, SLICERX_CONFIG: file },
    })
    expect(stdout).toContain('--mimir-cloud-status')
    expect(stdout).toContain('yourmate')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)

it('reads defaults and the assistant from the resolved edition file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-edition-'))
  try {
    const file = join(dir, 'edition.json')
    writeFileSync(file, JSON.stringify({ brand: { name: 'LayerMate' } }))
    expect(editionAssistantFromEnv({ SLICERX_CONFIG: file })).toEqual({ name: 'mimir', icon: 'builtin:mimir' })
    const assistant = { name: 'yourmate', icon: 'helper.svg', accent: '#006b65' }
    writeFileSync(file, JSON.stringify({ brand: { name: 'LayerMate', assistant } }))
    expect(editionAssistantFromEnv({ SLICERX_CONFIG: file })).toEqual(assistant)
    expect(editionAssistantFromEnv({})).toBeUndefined()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('uses the Path B name in MCP instructions and display copy without changing tool names', async () => {
  setAssistantName('yourmate')
  const h = await connect()
  expect(h.client.getInstructions()).toContain('yourmate skills')
  const { tools } = await h.client.listTools()
  expect(tools.find((t) => t.name === 'slicerx_mimir_cloud_status')?.description).toContain('yourmate cloud')
  expect(tools.find((t) => t.name === 'slicerx_local_ai_check')?.description).toContain("yourmate's model")
  expect(tools.some((t) => t.name === 'slicerx_app_assistant')).toBe(true)
  const catalog = await h.client.readResource({ uri: 'slicerx://pilot/skills' })
  expect(catalog.contents[0]).toMatchObject({ text: expect.stringContaining('yourmate skill catalog') })
  await h.client.close()
})

it('reads the open edition identity through the existing app.info route', async () => {
  const assistant = { name: 'yourmate', icon: 'https://example.com/helper.svg', accent: { light: '#006b65', dark: '#63e6d4' }, enabled: true }
  const call = vi.fn(async () => ({ assistant }))
  const [tool] = appAssistantTools({ call } as AppLinkCaller, 'LayerMate')
  expect(tool!.permission).toBe('read')
  expect((await tool!.run({} as never, {} as never)).output).toEqual(assistant)
  expect(call).toHaveBeenCalledWith('app.info', {})
})

it('reports an unavailable link and never invents a default for an older app', async () => {
  const [missing] = appAssistantTools(undefined, 'LayerMate')
  await expect(missing!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  const [old] = appAssistantTools({ call: async () => ({}) } as AppLinkCaller, 'LayerMate')
  await expect(old!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_supported' })
  const [denied] = appAssistantTools({ call: async () => { throw Object.assign(new Error('denied'), { code: 'forbidden' }) } }, 'LayerMate')
  await expect(denied!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
})

it('explains client setup when a hub code cannot request an app grant', async () => {
  const [tool] = appAssistantTools({ call: async () => { throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' }) } }, 'LayerMate')
  await expect(tool!.run({} as never, {} as never)).rejects.toMatchObject({
    code: 'not_configured',
    details: { appLink: 'unauthorized' },
    message: expect.stringContaining('Connect it in Settings and use the generated client configuration'),
  })
})
