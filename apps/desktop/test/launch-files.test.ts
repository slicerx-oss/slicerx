// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// Files the system hands over at launch are asked for as the host is made, so they reach the app's first listener at
// once, before the studio first draws.
import { describe, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({ waiting: [] as { id: string; name: string }[][] }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => (cmd === 'opened_take' ? (shell.waiting.shift() ?? []) : null),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }))

const { createTauriFiles } = await import('../src/host/files')

describe('files handed over at launch', () => {
  it('reach the first listener as soon as it listens, and only once', async () => {
    shell.waiting.push([{ id: '1', name: 'project.3mf' }])
    const files = createTauriFiles()
    await Promise.resolve()
    await Promise.resolve()
    const got: string[] = []
    files.onOpenRequest((refs) => got.push(...refs.map((r) => r.name)))
    // delivered in the same task the app listens in, not after a round trip
    expect(got).toEqual(['project.3mf'])
    files.onOpenRequest((refs) => got.push(...refs.map((r) => `again ${r.name}`)))
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toEqual(['project.3mf'])
  })

  it('reach a listener that came before the answer once it comes', async () => {
    shell.waiting.push([{ id: '2', name: 'early.3mf' }])
    const files = createTauriFiles()
    const got: string[] = []
    files.onOpenRequest((refs) => got.push(...refs.map((r) => r.name)))
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toEqual(['early.3mf'])
  })

  it('start the geometry engine for each file as soon as the shell names it', async () => {
    shell.waiting.push([{ id: '3', name: 'big.3mf' }, { id: '4', name: 'part.stl' }])
    const started: string[] = []
    createTauriFiles((name) => started.push(name))
    await new Promise((r) => setTimeout(r, 0))
    // before any listener, so the engine loads while the studio is still starting
    expect(started).toEqual(['big.3mf', 'part.stl'])
  })

  it('start nothing when no file was handed over', async () => {
    const started: string[] = []
    createTauriFiles((name) => started.push(name))
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual([])
  })
})
