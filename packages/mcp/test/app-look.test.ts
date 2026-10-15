// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The look tools forward to the open app, read the view preferences back, check their arguments before anything leaves,
// and pass the app's refusals on with their meaning.
import { describe, expect, it, vi } from 'vitest'
import { appLookTools, type AppLook } from '../src/app-look'
import type { AppLinkCaller } from '../src/app-route'
import { ToolInputError } from '../src/errors'

const refuse = (code: string) => (async () => {
  throw Object.assign(new Error(`refused: ${code}`), { code })
}) as AppLinkCaller['call']

describe('app look tools', () => {
  it('preserves edition color read-back from the running app', async () => {
    const look: AppLook = { toolbarSize: 'large', theme: { scheme: 'light', visuals: { '--accent': '#146676' }, overrides: { '--accent': '#146676' } } }
    const [tool] = appLookTools({ call: async () => look } as unknown as AppLinkCaller, 'Harbor')
    expect((await tool!.run({} as never, {} as never)).output).toEqual(look)
  })
  it('read the preferences and set them, each answer read back from the app', async () => {
    let look: AppLook = { toolbarSize: 'large', modelFraming: 'selection' }
    const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === 'look.set') look = { ...look, ...args }
      return look
    })
    const [get, set] = appLookTools({ call } as AppLinkCaller, 'SlicerX')
    expect(get!.name).toBe('app.look')
    expect(set!.name).toBe('app.look_set')
    expect(get!.permission).toBe('read')
    expect(set!.permission).toBe('read')
    const read = await get!.run({} as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('look.get', {})
    expect(read.output).toEqual({ toolbarSize: 'large', modelFraming: 'selection' })
    expect(read.summary).toBe('Toolbar size Large (32 px); Frame the view: Always.')
    const framed = await set!.run(set!.input.parse({ modelFraming: 'open' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('look.set', { modelFraming: 'open' })
    expect(framed.output).toEqual({ toolbarSize: 'large', modelFraming: 'open' })
    expect(framed.summary).toBe('Toolbar size Large (32 px); Frame the view: On open and add.')
    const both = await set!.run(set!.input.parse({ toolbarSize: 'small', modelFraming: 'selection' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('look.set', { modelFraming: 'selection', toolbarSize: 'small' })
    expect(both.output).toEqual({ toolbarSize: 'small', modelFraming: 'selection' })
    // an edition without Model reads Toolbar size only
    const [plain] = appLookTools({ call: async () => ({ toolbarSize: 'medium' }) } as unknown as AppLinkCaller, 'SlicerX')
    expect((await plain!.run({} as never, {} as never)).summary).toBe('Toolbar size Medium (24 px).')
  })

  it('check the arguments before anything leaves', () => {
    const [, set] = appLookTools({ call: vi.fn() } as unknown as AppLinkCaller, 'SlicerX')
    for (const bad of [{}, { modelFraming: 'sometimes' }, { toolbarSize: 'huge' }, { toolbarSize: 32 }]) expect(set!.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    for (const good of [{ modelFraming: 'open' }, { toolbarSize: 'medium' }, { modelFraming: 'selection', toolbarSize: 'small' }]) expect(set!.input.safeParse(good).success, JSON.stringify(good)).toBe(true)
  })

  it("say how to reach the app while the link is off or missing, and keep the app's own refusals", async () => {
    const [none] = appLookTools(undefined, 'SlicerX')
    expect(((await none!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('not_configured')
    for (const code of ['app_link_off', 'app_closed', 'forbidden']) {
      const [get] = appLookTools({ call: refuse(code) }, 'SlicerX')
      const e = (await get!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError
      expect(e.code, code).toBe('not_configured')
      expect(e.message, code).toMatch(/SlicerX is closed/)
    }
    for (const [code, want] of [['invalid_input', 'invalid_input'], ['not_found', 'not_supported']]) {
      const [, set] = appLookTools({ call: refuse(code!) }, 'SlicerX')
      expect(((await set!.run({ modelFraming: 'open' } as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code, code).toBe(want)
    }
  })
  it('reads the 3D view look back, preset named in the summary', async () => {
    const look: AppLook = { toolbarSize: 'large', modelFraming: 'selection', viewport: { preset: 'light-studio', themeBackdrop: false, look: { version: 1, plate: { borderGlow: 0.35 } } } }
    const [get] = appLookTools({ call: async () => look } as unknown as AppLinkCaller, 'SlicerX')
    const read = await get!.run({} as never, {} as never)
    expect(read.output).toEqual(look)
    expect(read.summary).toBe('Toolbar size Large (32 px); Frame the view: Always; 3D view look: Light studio.')
    const own = await appLookTools({ call: async () => ({ ...look, viewport: { ...look.viewport!, preset: 'dark-precision', themeBackdrop: true } }) } as unknown as AppLinkCaller, 'SlicerX')[0]!.run({} as never, {} as never)
    expect(own.summary).toBe("Toolbar size Large (32 px); Frame the view: Always; 3D view look: Dark precision with the theme's backdrop.")
  })
})
