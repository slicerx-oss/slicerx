// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate tools forward to the open app, read the plates back, check their arguments before anything leaves, and pass
// the app's refusals on with their meaning.
import { describe, expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { appPlateTools, type AppPlates } from '../src/app-plates'
import { ToolInputError } from '../src/errors'

const plates = (shown: number): AppPlates => ({
  shown,
  count: 3,
  plates: [
    { number: 1, id: 'p1', name: 'Plate 1', objects: 1, slice: 'sliced', shown: shown === 1 },
    { number: 2, id: 'p2', name: 'Deck box shell, front half', objects: 1, slice: 'not-sliced', shown: shown === 2 },
    { number: 3, id: 'p3', name: 'Plate 3', objects: 0, slice: 'empty', shown: shown === 3 },
  ],
})
const refuse = (code: string) => (async () => {
  throw Object.assign(new Error(`refused: ${code}`), { code })
}) as AppLinkCaller['call']

describe('app plate tools', () => {
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

  it('say when the view draws another plate than the one shown', async () => {
    const answer = (drawn: number | null | undefined) => ({ call: vi.fn(async () => ({ ...plates(1), ...(drawn !== undefined ? { drawn } : {}) })) }) as unknown as AppLinkCaller
    const summary = async (drawn: number | null | undefined) => (await appPlateTools(answer(drawn), 'SlicerX')[0]!.run({} as never, {} as never)).summary
    expect(await summary(1)).toBe('Plate 1 of 3 is shown, sliced; 1 plate needs a slice.')
    expect(await summary(undefined)).toBe('Plate 1 of 3 is shown, sliced; 1 plate needs a slice.')
    expect(await summary(2)).toBe('Plate 1 of 3 is shown, sliced; 1 plate needs a slice. The view still draws plate 2.')
    expect(await summary(null)).toBe('Plate 1 of 3 is shown, sliced; 1 plate needs a slice. The view has not drawn it yet.')
  })

  it('explains why an unregistered client will not get a permission prompt', async () => {
    const [list] = appPlateTools({ call: refuse('unauthorized') }, 'SlicerX')
    const e = (await list!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError
    expect(e.code).toBe('not_configured')
    expect(e.message).toContain('Connect it in Settings and use the generated client configuration')
    expect(e.message).toContain('A hub pairing code alone does not open a permission prompt')
    expect(e.details).toEqual({ appLink: 'unauthorized' })
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
