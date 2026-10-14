// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate tools forward to the open app, read the plates back, check their arguments before anything leaves, and pass
// the app's refusals on with their meaning.
import { describe, expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { appPlateTools, type AppPlates } from '../src/app-plates'
import { ToolInputError } from '../src/errors'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const plates = (shown: number): AppPlates => ({
  shown,
  count: 3,
  plates: [
    { number: 1, id: 'p1', name: 'Plate 1', objects: 1, slice: 'sliced', shown: shown === 1, settings: {}, entries: [] },
    { number: 2, id: 'p2', name: 'Deck box shell, front half', objects: 1, slice: 'not-sliced', shown: shown === 2, settings: {}, entries: [] },
    { number: 3, id: 'p3', name: 'Plate 3', objects: 0, slice: 'empty', shown: shown === 3, settings: {}, entries: [] },
  ],
})
const refuse = (code: string) => (async () => {
  throw Object.assign(new Error(`refused: ${code}`), { code })
}) as AppLinkCaller['call']

describe('app plate tools', () => {
  const edits = [
    ['add', { name: 'Lid' }], ['duplicate', { plate: 1, name: 'Copy' }], ['rename', { plate: 'p2', name: 'Shell' }],
    ['settings', { plate: 1, settings: { filamentOrder: [2, 1] }, replace: true }],
    ['remove', { plate: 3, deleteObjects: true }], ['move', { plate: 2, objects: ['copy-id'] }],
  ] as const

  it('forwards each edit with edit policy and keeps the complete read-back', async () => {
    const state = { ...plates(1), changedPlate: 'p2' }
    const call = vi.fn(async () => state)
    const tools = appPlateTools({ call } as AppLinkCaller, 'SlicerX')
    for (const [action, args] of edits) {
      const tool = tools.find((t) => t.name === `app.plate_${action}`)!
      expect(tool.permission).toBe('slice')
      expect((await tool.run(tool.input.parse(args) as never, {} as never)).output).toBe(state)
      expect(call).toHaveBeenLastCalledWith(`plates.${action}`, args)
    }
    for (const code of ['refused', 'denied', 'read_only']) {
      const tool = appPlateTools({ call: refuse(code) }, 'SlicerX').find((t) => t.name === 'app.plate_remove')!
      await expect(tool.run({ plate: 1 } as never, {} as never)).rejects.toMatchObject({ code: 'not_supported' })
    }
  })

  it('reaches every plate edit through the CLI and stops the chain when the app is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-plate-cli-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
    try {
      for (const [action, args] of edits) {
        const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--printers', 'off', '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), 'call', `app_plate_${action}`, JSON.stringify(args), 'app_plates'], {
          cwd: resolve(__dirname, '..'), env: { ...env, HOME: dir, USERPROFILE: dir }, timeout: 20_000,
        }).then(() => { throw new Error('The missing app must fail') }, (e: unknown) => e as { code: number; stdout: string })
        expect(result.code).toBe(1)
        const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ tool: `slicerx_app_plate_${action}`, ok: false, output: { error: { code: 'not_configured' } } })
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 90_000)

  it('list the plates and show one, each answer read back from the app', async () => {
    let shown = 1
    const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === 'plates.show') shown = args?.['step'] === 'next' ? shown + 1 : Number(args?.['plate'] ?? shown)
      return plates(shown)
    })
    const [list, show] = appPlateTools({ call } as AppLinkCaller, 'SlicerX')
    expect(list!.name).toBe('app.plates')
    expect(show!.name).toBe('app.plate_show')
    const listed = await list!.run({} as never, {} as never)
    expect(listed.output).toEqual(plates(1))
    expect(listed.summary).toBe('Plate 1 of 3 is shown, sliced; 1 plate needs a slice.')
    const next = await show!.run(show!.input.parse({ step: 'next' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('plates.show', { step: 'next' })
    expect(next.output).toMatchObject({ shown: 2 })
    expect(next.summary).toBe('Plate 2 (Deck box shell, front half) of 3 is shown, not sliced; 1 plate needs a slice.')
    const byNumber = await show!.run(show!.input.parse({ plate: 3 }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('plates.show', { plate: 3 })
    expect(byNumber.output).toMatchObject({ shown: 3, plates: [{ shown: false }, { shown: false }, { shown: true }] })
  })

  it('check the arguments before anything leaves', () => {
    const [, show] = appPlateTools({ call: vi.fn() } as unknown as AppLinkCaller, 'SlicerX')
    for (const bad of [{}, { plate: 1, step: 'next' }, { plate: 0 }, { plate: 1.5 }, { step: 'last' }]) expect(show!.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    for (const good of [{ plate: 27 }, { plate: 'plate-abc' }, { step: 'previous' }]) expect(show!.input.safeParse(good).success, JSON.stringify(good)).toBe(true)
  })

  it('say how to reach the app while the link is off or missing, and keep the app\'s own refusals', async () => {
    const [none] = appPlateTools(undefined, 'SlicerX')
    expect(((await none!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('not_configured')
    for (const code of ['app_link_off', 'app_closed', 'forbidden']) {
      const [list] = appPlateTools({ call: refuse(code) }, 'SlicerX')
      const e = (await list!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError
      expect(e.code, code).toBe('not_configured')
      expect(e.message, code).toMatch(/SlicerX is closed/)
    }
    for (const [code, want] of [['busy', 'busy'], ['not_found', 'not_found'], ['invalid_input', 'invalid_input']]) {
      const [, show] = appPlateTools({ call: refuse(code!) }, 'SlicerX')
      expect(((await show!.run({ step: 'next' } as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code, code).toBe(want)
    }
  })
})
