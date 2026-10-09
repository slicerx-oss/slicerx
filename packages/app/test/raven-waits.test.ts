// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// Huginn and Muninn come only for a wait past about 1.2 s: muninn along a slice's progress, the two over the plate
// while a model loads, and they leave when the wait ends.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RAVEN_WAIT_MS } from '../src/lib/waited'
import { set } from '../src/state/store'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HostContext } from '../src/host'
import { UploadState } from '../src/features/store/upload'
import { SliceBlock } from '../src/workspaces/prepare/prepare-panes'
import { SliceProgress } from '../src/workspaces/slice-progress'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let el: HTMLElement
let root: Root
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))
const has = (id: string) => el.querySelector(`[data-testid="${id}"]`) !== null

// The ravens' own chunk, loaded once, so the timings below are the component's and not the import's.
beforeAll(async () => {
  await import('../src/ravens/waits')
})

beforeEach(async () => {
  set({ slice: { status: 'idle' }, plateLoading: false })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () => root.render(createElement(SliceProgress)))
})
afterEach(async () => {
  await act(async () => root.unmount())
  el.remove()
})

describe('ravens through the longer waits', () => {
  it('a quick slice shows the bar and no raven', async () => {
    await act(async () => set({ slice: { status: 'running', progress: { stage: 'layers', fraction: 0.5 }, startedAt: 0 } }))
    await wait(600)
    expect(el.querySelector('.slice-progress')).not.toBeNull()
    expect(has('raven-slice-glide')).toBe(false)
    await act(async () => set({ slice: { status: 'idle' } }))
    await wait(RAVEN_WAIT_MS)
    expect(has('raven-slice-glide')).toBe(false)
  })

  it('a long load brings the two ravens over the plate, and they fly off when it ends', async () => {
    await act(async () => set({ plateLoading: true }))
    await wait(300)
    expect(has('raven-loading')).toBe(false)
    await wait(RAVEN_WAIT_MS + 200)
    expect(has('raven-loading')).toBe(true)
    await act(async () => set({ plateLoading: false }))
    expect(el.querySelector('[data-testid="raven-loading"][data-leaving]')).not.toBeNull()
    await wait(600)
    expect(has('raven-loading')).toBe(false)
  })

  it('a long slice brings muninn to ride the Estimate bar, and he goes when it ends', async () => {
    set({ plate: [{ id: 'a', name: 'a', handle: { id: 'm', hash: 'h', name: 'a', triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [], colors: ['#fff'], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] })
    const host = { kind: 'web', capabilities: {} }
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: host as never }, createElement(SliceBlock)))))
    await act(async () => set({ slice: { status: 'running', progress: { stage: 'paths', fraction: 0.5 }, startedAt: 0 } }))
    await wait(600)
    expect(has('raven-slice-glide')).toBe(false)
    await wait(RAVEN_WAIT_MS)
    expect(has('raven-slice-glide')).toBe(true)
    expect(el.querySelector('.slicing .rv-ride [data-testid="raven-slice-glide"]')).not.toBeNull()
    await act(async () => set({ slice: { status: 'idle' } }))
    expect(has('raven-slice-glide')).toBe(false)
  })

  it('an upload past about 1.2 s gets the raven carrying the file, and it goes when the upload is done', async () => {
    const line = (busy: boolean, text: string) => createElement(UploadState, { busy, text })
    await act(async () => root.render(line(true, 'Uploading the file')))
    await wait(600)
    expect(has('raven-upload-carry')).toBe(false)
    await wait(RAVEN_WAIT_MS)
    expect(has('raven-upload-carry')).toBe(true)
    expect(el.querySelector('[data-testid="upload-state"]')?.textContent).toBe('Uploading the file')
    await act(async () => root.render(line(false, 'Ready to send')))
    expect(has('raven-upload-carry')).toBe(false)
  })

  it('a quick upload never shows the raven', async () => {
    await act(async () => root.render(createElement(UploadState, { busy: true, text: 'Uploading the file' })))
    await wait(500)
    await act(async () => root.render(createElement(UploadState, { busy: false, text: 'Ready to send' })))
    await wait(RAVEN_WAIT_MS)
    expect(has('raven-upload-carry')).toBe(false)
  })
})
