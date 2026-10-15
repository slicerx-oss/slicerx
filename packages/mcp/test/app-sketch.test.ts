// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads and sets the dimension boxes of the sketch open in the app over MCP: each call goes to the app link,
// the answer is the sketch read back, bad arguments never leave, and the app's refusals keep their meaning.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { appSketchTools, type AppSketchBoxes } from '../src/app-sketch'
import { ToolInputError } from '../src/errors'
import { createContext, createSlicerxServer } from '../src/index'

const read: AppSketchBoxes = {
  dof: 4,
  shapes: [
    { shape: 'rectangle', loop: 0, boxes: [{ box: 'width', label: 'Width', value: 20, unit: 'mm', set: null }, { box: 'height', label: 'Height', value: 10, unit: 'mm', set: null }] },
    { shape: 'line', loop: 1, seg: 0, boxes: [{ box: 'length', label: 'Length', value: 12, unit: 'mm', set: 'driving' }, { box: 'angle', label: 'Angle', value: 30, unit: 'deg', set: 'driven' }] },
  ],
  dimensions: [{ index: 3, type: 'length', value: 12, driven: false }],
}

describe('app sketch box tools', () => {
  it('read the boxes and set one through an MCP client, each answer read back from the app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-app-sketch-'))
    let now = read
    const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === 'sketch.box_set') now = { ...now, dof: 3, driven: false, shapes: [{ ...now.shapes[0]!, boxes: [{ ...now.shapes[0]!.boxes[0]!, value: Number(args?.['value']), set: 'driving' }, now.shapes[0]!.boxes[1]!] }, now.shapes[1]!] }
      return now
    })
    const ctx = await createContext({ engine: 'stub', printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
    ctx.tools = appSketchTools({ call } as AppLinkCaller, 'SlicerX')
    const server = createSlicerxServer(ctx)
    const client = new Client({ name: 'sketch-boxes-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(a), client.connect(b)])
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['slicerx_app_sketch_boxes', 'slicerx_app_sketch_box_set']))
      const got = await client.callTool({ name: 'slicerx_app_sketch_boxes', arguments: {} })
      expect(call).toHaveBeenLastCalledWith('sketch.boxes', {})
      expect(got).toMatchObject({ structuredContent: { ok: true, output: read } })
      expect((got.structuredContent as { summary: string }).summary).toBe('rectangle 0 (Width 20 mm, Height 10 mm); line 1:0 (Length 12 mm set, Angle (30) deg); 4 degrees of freedom left.')
      const set = await client.callTool({ name: 'slicerx_app_sketch_box_set', arguments: { loop: 0, box: 'width', value: 25 } })
      expect(call).toHaveBeenLastCalledWith('sketch.box_set', { loop: 0, box: 'width', value: 25 })
      expect(set).toMatchObject({ structuredContent: { ok: true, output: { dof: 3, driven: false, shapes: [{ boxes: [{ box: 'width', value: 25, set: 'driving' }, { box: 'height' }] }, { shape: 'line' }] } } })
      await client.callTool({ name: 'slicerx_app_sketch_box_set', arguments: { loop: 1, seg: 0, box: 'angle', value: null } })
      expect(call).toHaveBeenLastCalledWith('sketch.box_set', { loop: 1, seg: 0, box: 'angle', value: null })
      // bad arguments never reach the app
      call.mockClear()
      for (const bad of [{ box: 'width', value: 1 }, { loop: 0, box: 'radius', value: 1 }, { loop: -1, box: 'width', value: 1 }, { loop: 0, box: 'width', value: '' }])
        expect(await client.callTool({ name: 'slicerx_app_sketch_box_set', arguments: bad }), JSON.stringify(bad)).toMatchObject({ isError: true })
      expect(call).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reach both from the command line, which says the app is needed when it is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-sketch-cli-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
    try {
      for (const [tool, args] of [['app_sketch_boxes', {}], ['app_sketch_box_set', { loop: 0, box: 'width', value: 25 }]] as const) {
        const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--printers', 'off', '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), 'call', tool, JSON.stringify(args)], { cwd: resolve(__dirname, '..'), env: { ...env, HOME: dir, USERPROFILE: dir } }).then(() => { throw new Error('Expected missing app') }, (e: unknown) => e as { code: number; stdout: string })
        expect(result.code).toBe(1)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows[0]).toMatchObject({ tool: `slicerx_${tool}`, ok: false, output: { error: { code: 'not_configured' } } })
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('say a driven value is kept driven', async () => {
    const [, set] = appSketchTools({ call: async () => ({ ...read, driven: true }) } as unknown as AppLinkCaller, 'SlicerX')
    expect((await set!.run(set!.input.parse({ loop: 0, box: 'width', value: 5 }) as never, {} as never)).summary).toMatch(/^Kept driven: it would over-define the sketch\. /)
  })

  it('say how to reach the app while the link is off, and keep the app refusals', async () => {
    const [none] = appSketchTools(undefined, 'SlicerX')
    expect(((await none!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('not_configured')
    const refuse = (code: string) => ({ call: async () => Promise.reject(Object.assign(new Error(`refused ${code}`), { code })) }) as unknown as AppLinkCaller
    expect(((await appSketchTools(refuse('app_link_off'), 'SlicerX')[0]!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('not_configured')
    expect(((await appSketchTools(refuse('not_found'), 'SlicerX')[0]!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('not_found')
    expect(((await appSketchTools(refuse('invalid_input'), 'SlicerX')[1]!.run({ loop: 0, box: 'width', value: 1 } as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('invalid_input')
  })
})
