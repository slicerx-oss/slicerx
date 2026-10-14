// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { appValueTools, type AppValuesResult } from '../src/app-values'
import type { AppLinkCaller } from '../src/app-route'

const state: AppValuesResult = { activePlate: 'p1', values: [{ name: 'wall', expression: '2mm', value: 2 }], builtIns: { nozzle: 0.4, clearance: 0.2 }, bindings: [], replayed: [], issues: [] }

describe('open-project value commands', () => {
  it('reaches each command from the CLI and refuses a missing app without running a later command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-value-cli-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
    const calls = [['app_values', {}], ['app_value_set', { name: 'wall', expression: '2' }], ['app_value_remove', { name: 'wall' }], ['app_step_bind', { design: 'o1', step: 1, expression: null }]] as const
    try {
      for (const [tool, args] of calls) {
        const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--printers', 'off', '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), 'call', tool, JSON.stringify(args), 'app_values'], { cwd: resolve(__dirname, '..'), env: { ...env, HOME: dir, USERPROFILE: dir } }).then(
          () => { throw new Error('The missing app must fail') },
          (e: unknown) => e as { code: number; stdout: string },
        )
        expect(result.code).toBe(1)
        const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ tool: `slicerx_${tool}`, ok: false, output: { error: { code: 'not_configured' } } })
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it('exposes the same project state and edit classes, preserving the method arguments', async () => {
    const call = vi.fn(async () => state)
    const tools = appValueTools({ call } as AppLinkCaller, 'SlicerX')
    expect(tools.map((t) => [t.name, t.permission])).toEqual([['app.values', 'read'], ['app.value_set', 'slice'], ['app.value_remove', 'slice'], ['app.step_bind', 'slice']])
    const args = [{}, { name: 'wall', expression: '2mm' }, { name: 'wall' }, { design: 'o1', step: 's1', expression: null }]
    for (const [i, tool] of tools.entries()) {
      expect((await tool.run(tool.input.parse(args[i]) as never, {} as never)).output).toBe(state)
      expect(call).toHaveBeenLastCalledWith(['values.list', 'values.set', 'values.remove', 'values.bind'][i], args[i])
    }
  })

  it('keeps unavailable links, denied edits and busy projects as errors', async () => {
    await expect(appValueTools(undefined, 'SlicerX')[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
    for (const [code, want] of [['app_closed', 'not_configured'], ['denied', 'not_supported'], ['read_only', 'not_supported'], ['busy', 'busy'], ['not_found', 'not_found']]) {
      const call = async () => { throw Object.assign(new Error('refused'), { code }) }
      const tool = appValueTools({ call }, 'SlicerX')[1]!
      await expect(tool.run({ name: 'wall', expression: '2' } as never, {} as never)).rejects.toMatchObject({ code: want })
    }
  })

  it('returns read-back in a failed edit instead of reporting a broken replay as success', async () => {
    const failed = { ...state, applied: true, issues: ['step 2 lost its face'] }
    const call = async <T>() => failed as T
    const tools = appValueTools({ call }, 'SlicerX')
    await expect(tools[1]!.run({ name: 'wall', expression: '2' } as never, {} as never)).rejects.toMatchObject({ code: 'invalid_input', details: { applied: true, issues: ['step 2 lost its face'] } })
    expect((await tools[0]!.run({} as never, {} as never)).output).toBe(failed)
  })
})
