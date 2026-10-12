// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design tools on the open app: while the app link answers they run there and say so once; model files and the
// file tools stay here; when the link is off or the app closed they run here; the app's refusals keep their meaning.
import { describe, expect, it, vi } from 'vitest'
import { APP_DESIGN_TOOLS, routeToApp, type AppLinkCaller } from '../src/app-route'
import { ToolInputError } from '../src/errors'
import { NO_ENGINE_HOST, designToolset } from '../src/toolset'

const fail = (code: string) => Object.assign(new Error(`refused: ${code}`), { code })

function routed(call: AppLinkCaller['call']) {
  const tools = routeToApp(designToolset(NO_ENGINE_HOST), { call }, 'SlicerX')
  const run = (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input as never, {} as never)
  return { tools, run }
}

describe('design tools over the app link', () => {
  it('route exactly the hub list, never the file tools', () => {
    const names = designToolset(NO_ENGINE_HOST).map((t) => t.name)
    for (const n of APP_DESIGN_TOOLS) expect(names, n).toContain(n)
    expect(APP_DESIGN_TOOLS.has('design.open')).toBe(false)
    expect(APP_DESIGN_TOOLS.has('design.save')).toBe(false)
  })

  it('run in the app while it answers, and say so on the first reply only', async () => {
    const call = vi.fn(async (method: string) => ({ summary: `ran ${method}`, output: { design: 'obj_1', steps: 1 } }))
    const { run } = routed(call as AppLinkCaller['call'])
    const first = await run('design.new', { name: 'Clip' })
    expect(call).toHaveBeenCalledWith('design.new', { name: 'Clip' })
    expect(first.summary).toMatch(/ran design.new \(in SlicerX\) Designs now live in the project open in SlicerX/)
    expect(first.output).toEqual({ design: 'obj_1', steps: 1, in: 'app' })
    const second = await run('geom.extrude', { design: 'obj_1', shape: { type: 'circle', diameterMm: 5 }, distance_mm: 2 })
    expect(second.summary).toBe('ran geom.extrude (in SlicerX)')
  })

  it('keep a model file here, and run here while the link is off or the app is closed', async () => {
    for (const code of ['app_link_off', 'app_closed']) {
      const call = vi.fn(async () => {
        throw fail(code)
      })
      const { run } = routed(call as AppLinkCaller['call'])
      const e = await run('design.new', { name: 'Clip' }).catch((x: unknown) => x)
      // Here means this server's own designs, which need an engine this test has none of.
      expect((e as ToolInputError).code, code).toBe('engine_unavailable')
    }
    const call = vi.fn()
    const { run } = routed(call as AppLinkCaller['call'])
    await run('geom.info', { model: '/tmp/part.stl' }).catch(() => undefined)
    expect(call).not.toHaveBeenCalled()
  })

  it('pass the app\'s refusals on with their meaning', async () => {
    for (const [code, want] of [
      ['read_only', 'not_supported'],
      ['denied', 'not_supported'],
      ['invalid_input', 'invalid_input'],
      ['not_found', 'not_found'],
      ['timeout', 'internal_error'],
    ] as const) {
      const { run } = routed((async () => {
        throw fail(code)
      }) as AppLinkCaller['call'])
      const e = await run('design.undo', { design: 'obj_1' }).catch((x: unknown) => x)
      expect(e, code).toBeInstanceOf(ToolInputError)
      expect((e as ToolInputError).code, code).toBe(want)
    }
  })
})
