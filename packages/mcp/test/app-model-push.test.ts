// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Push and pull tools forward to the open app, read the tool back, check the distance before anything leaves, and
// pass the app's refusals on with their meaning.
import { describe, expect, it, vi } from 'vitest'
import { appModelPushTools, type AppPush } from '../src/app-model-push'
import type { AppLinkCaller } from '../src/app-route'
import { ToolInputError } from '../src/errors'

const refuse = (code: string) => (async () => {
  throw Object.assign(new Error(`refused: ${code}`), { code })
}) as AppLinkCaller['call']

const shut: AppPush = { open: false, face: null, text: '', distanceMm: null, operation: null, operationLabel: null, busy: false }
const face = { object: 'Box', part: 0, at: [0, 0, 20] as [number, number, number], normal: [0, 0, 1] as [number, number, number], thicknessMm: 20 }

describe('app model push tools', () => {
  it('read the open tool and type a distance, each answer read back from the app', async () => {
    let push: AppPush = { ...shut, open: true, face }
    const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === 'model.push_set') {
        const d = args!['distanceMm'] as number
        push = { ...push, text: String(d), distanceMm: d, operation: d > 0 ? 'pull' : d <= -20 ? 'through' : 'cut', operationLabel: d > 0 ? 'Pull out' : d <= -20 ? 'Cut through' : 'Cut' }
      }
      return push
    })
    const [get, set] = appModelPushTools({ call } as AppLinkCaller, 'SlicerX')
    expect(get!.name).toBe('app.model_push')
    expect(set!.name).toBe('app.model_push_set')
    expect(get!.permission).toBe('read')
    expect(set!.permission).toBe('read')
    const read = await get!.run({} as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('model.push', {})
    expect(read.summary).toBe('Push and pull has a face on Box: no distance yet.')
    const typed = await set!.run(set!.input.parse({ distanceMm: -5 }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('model.push_set', { distanceMm: -5 })
    expect(typed.output).toMatchObject({ distanceMm: -5, operation: 'cut' })
    expect(typed.summary).toBe('Push and pull has a face on Box: -5 mm, Cut.')
    const [plain] = appModelPushTools({ call: async () => shut } as unknown as AppLinkCaller, 'SlicerX')
    expect((await plain!.run({} as never, {} as never)).summary).toBe('Push and pull is not open.')
  })

  it('check the distance before anything leaves', () => {
    const [, set] = appModelPushTools({ call: vi.fn() } as unknown as AppLinkCaller, 'SlicerX')
    for (const bad of [{}, { distanceMm: '5' }, { distanceMm: Number.NaN }, { distanceMm: 20_000 }]) expect(set!.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    for (const good of [{ distanceMm: 5 }, { distanceMm: -0.5 }]) expect(set!.input.safeParse(good).success, JSON.stringify(good)).toBe(true)
  })

  it("say how to reach the app while the link is off or missing, and keep the app's own refusals", async () => {
    const [none] = appModelPushTools(undefined, 'SlicerX')
    expect(((await none!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('not_configured')
    for (const code of ['app_link_off', 'app_closed', 'forbidden']) {
      const [get] = appModelPushTools({ call: refuse(code) }, 'SlicerX')
      const e = (await get!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError
      expect(e.code, code).toBe('not_configured')
      expect(e.message, code).toMatch(/SlicerX is closed/)
    }
    for (const [code, want] of [['invalid_input', 'invalid_input'], ['not_found', 'not_supported'], ['busy', 'busy']]) {
      const [, set] = appModelPushTools({ call: refuse(code!) }, 'SlicerX')
      expect(((await set!.run({ distanceMm: 5 } as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code, code).toBe(want)
    }
  })
})
