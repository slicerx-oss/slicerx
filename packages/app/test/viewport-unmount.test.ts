// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A view that unmounts while its 3D start is still in its retries starts nothing more: no 2D fallback, warning or toast
// after it is gone. Left running, the start reached the document after the test environment was torn down (#1400).
import type { Host } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SlicerXApp } from '../src/app'
import { set } from '../src/state/store'

/** A host that answers every call with nothing and has no engine: enough to draw the workspace. */
function stubHost(): Host {
  const nothing = () => undefined
  const quiet: ProxyHandler<object> = { get: (_, k) => (k === 'then' ? undefined : () => nothing) }
  return {
    kind: 'desktop',
    capabilities: { nativeSlicing: true, orcaEngine: false, printers: 'none', webgpu: false, threads: 4, secureStorage: true },
    build: { version: '1.0.0', commit: '0123456789abcdef', sourceUrl: 'https://example.com/tree/0123456789abcdef' },
    slicer: new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : () => Promise.reject(new Error('no engine in this test'))) }),
    files: new Proxy({}, quiet),
    secrets: new Proxy({}, quiet),
  } as unknown as Host
}

// jsdom has no media queries, scrolling or resize observers; the workspace uses all three.
Element.prototype.scrollTo ??= () => undefined
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
if (!window.matchMedia) window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

it('stops a viewport start that is still trying when the view unmounts', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  set({ setup: null })
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  flushSync(() => root.render(createElement(SlicerXApp, { host: stubHost() })))
  // The view loads lazily; its start begins once its stage is in the page. Unmount right then, with the start still
  // loading the viewport or trying for a context (jsdom has no WebGL2, so every try fails).
  for (let i = 0; i < 1000 && !document.querySelector('.vp-stage'); i++) await new Promise((r) => setTimeout(r, 10))
  expect(document.querySelector('.vp-stage')).not.toBeNull()
  root.unmount()
  // A start left running opens its 2D fallback once the viewport has loaded and the last retry (context-retry.ts,
  // 1500 ms) has failed: about 3 s in a cold test worker. Wait well past that.
  await new Promise((r) => setTimeout(r, 5000))
  expect(warn.mock.calls.filter(([m]) => String(m).startsWith('Viewport failed to start'))).toEqual([])
}, 15_000)
