// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint names filaments 1 to 32, as many as a project holds. A client asking to paint filament 33 or up is refused in
// plain words, on a design and in the running app, before anything is painted.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'
import { appPaintTools } from '../src/app-paint'
import { appPaintPreviewInput } from '../src/app-paint-input'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'
import type { Designs } from '../src/design'
import { paintTools } from '../src/paint'
import { text } from './helpers'

const REFUSAL = /Paint uses filaments 1 to 32, as many as a project holds\./

describe('paint states above 32', () => {
  it('a design paint preview takes filament 32 and refuses 33, and a replace from 33', () => {
    const preview = paintTools({ deps: {} } as unknown as Designs).find((t) => t.name === 'paint.preview')!
    const parse = (args: Record<string, unknown>) => preview.input.safeParse({ design: 'd1', ...args })
    expect(parse({ state: 32, target: { kind: 'part' } }).success).toBe(true)
    expect(parse({ state: 19, target: { kind: 'replace', from: 32 } }).success).toBe(true)
    for (const args of [{ state: 33, target: { kind: 'part' } }, { state: 1, target: { kind: 'replace', from: 33 } }]) {
      const r = parse(args)
      expect(r.success).toBe(false)
      expect(r.error?.issues[0]?.message).toMatch(REFUSAL)
    }
  })

  it('the live app paint preview takes filament 32 and refuses 33 without calling the app', async () => {
    expect(appPaintPreviewInput.safeParse({ object: 'body', layer: 'color', state: 32, target: { kind: 'part' } }).success).toBe(true)
    const bad = appPaintPreviewInput.safeParse({ object: 'body', layer: 'color', state: 33, target: { kind: 'part' } })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.message).toMatch(REFUSAL)

    const dir = mkdtempSync(join(tmpdir(), 'sx-paint-limit-'))
    const call = vi.fn(async () => ({ summary: 'Painted', output: {} }))
    const ctx = await createContext({ engine: 'sx', printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
    ctx.tools = appPaintTools({ call } as AppLinkCaller, 'SlicerX')
    const server = createSlicerxServer(ctx)
    const client = new Client({ name: 'paint-limit-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(a), client.connect(b)])
      const r = (await client.callTool({ name: 'slicerx_app_paint_preview', arguments: { object: 'body', layer: 'color', state: 40, target: { kind: 'part' } } })) as CallToolResult
      expect(r.isError).toBe(true)
      expect(text(r)).toMatch(REFUSAL)
      expect(call).not.toHaveBeenCalled()
    } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
