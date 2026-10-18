// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What resolveConfig costs per store write with a maker preset loaded: the time of one call, and how many calls the Prepare
// panels make when the store changes something unrelated (a toast) and when an override changes. Prints its numbers and
// runs only with SX_PERF=1, so a loaded machine never fails it.
import type { LayoutSpec } from '@slicerx/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type FunctionComponent } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, describe, expect, it, vi } from 'vitest'

const tally = vi.hoisted(() => ({ calls: 0, ms: 0 }))

vi.mock('../src/adapters/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/adapters/config')>()
  return {
    ...real,
    resolveConfig: (...args: Parameters<typeof real.resolveConfig>) => {
      const t = performance.now()
      try {
        return real.resolveConfig(...args)
      } finally {
        tally.calls++
        tally.ms += performance.now() - t
      }
    },
  }
})

const { hasProfileLayer, resolveConfig } = await import('../src/adapters/config')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { get, set, toast } = await import('../src/state/store')
const { HostContext } = await import('../src/host')

const roots: Root[] = []
afterAll(() => roots.forEach((r) => r.unmount()))

const reset = (): void => {
  tally.calls = 0
  tally.ms = 0
}

describe.runIf(process.env['SX_PERF'] === '1')('resolveConfig cost', () => {
  it('per call and per store write, with a Bambu Lab A1 preset', async () => {
    startProfileSync()
    set({ printerModel: { vendor: 'Bambu Lab', model: 'A1' }, easyTouched: [] })
    await profileReady()
    expect(hasProfileLayer()).toBe(true)

    // One call, same easy and overrides references (what most store subscribers pass).
    for (let i = 0; i < 50; i++) resolveConfig(get().easy, get().overrides)
    reset()
    const N = 500
    for (let i = 0; i < N; i++) resolveConfig(get().easy, get().overrides)
    const sameRef = tally.ms / N
    // One call, new references each time (a write that did change easy or overrides).
    reset()
    for (let i = 0; i < N; i++) resolveConfig({ ...get().easy }, { ...get().overrides })
    const freshRef = tally.ms / N

    // Mount the Prepare panels that read the resolved config.
    const panels: Array<[string, FunctionComponent<never>, object]> = []
    const load = async (name: string, path: string, props: object = {}): Promise<void> => {
      const mod = (await import(path)) as Record<string, FunctionComponent<never>>
      panels.push([name, mod[name]!, props])
    }
    await load('PlateToolbar', '../src/workspaces/prepare/plate-toolbar', { layout: { toolbar: 'top' } as unknown as LayoutSpec })
    await load('EasySettingsPanel', '../src/workspaces/prepare/easy-settings')
    await load('ExpertSettings', '../src/workspaces/prepare/expert-settings')
    await load('MachineCard', '../src/workspaces/prepare/machine-card')
    await load('PlateList', '../src/workspaces/prepare/plate-list', { layout: { toolbar: 'top' } as unknown as LayoutSpec })
    await load('ObjectVolumes', '../src/workspaces/prepare/object-volumes')
    const mounted: string[] = []
    for (const [name, C, props] of panels) {
      const root = createRoot(document.createElement('div'))
      try {
        const tree = createElement(HostContext.Provider, { value: { kind: 'web', capabilities: {} } as never }, createElement(C as FunctionComponent<object>, props))
        flushSync(() => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, tree)))
        roots.push(root)
        mounted.push(name)
      } catch (e) {
        console.log(`resolve-config-cost: ${name} did not mount: ${String(e).slice(0, 120)}`)
        root.unmount()
      }
    }

    const W = 100
    reset()
    for (let i = 0; i < W; i++) flushSync(() => toast(`note ${i}`))
    const toastCalls = tally.calls / W
    const toastMs = tally.ms / W

    reset()
    for (let i = 0; i < W; i++) flushSync(() => set((s) => ({ overrides: { ...s.overrides, wall_loops: 2 + (i % 3) } })))
    const editCalls = tally.calls / W
    const editMs = tally.ms / W

    const f = (n: number): string => n.toFixed(4)
    console.log(
      [
        `resolve-config-cost: mounted ${mounted.join(', ')}`,
        `resolve-config-cost: per call, same refs ${f(sameRef)} ms, new refs ${f(freshRef)} ms`,
        `resolve-config-cost: toast write, ${toastCalls.toFixed(2)} calls, ${f(toastMs)} ms in resolveConfig per write`,
        `resolve-config-cost: override write, ${editCalls.toFixed(2)} calls, ${f(editMs)} ms in resolveConfig per write`,
      ].join('\n'),
    )
  })
})
