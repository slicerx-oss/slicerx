// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// heimdall's plate check on the desktop: the request goes to the check_plate command with the meshes by number and a
// job number that only grows, the answer is read as the contract's PlateCheck, and an abort lets the answer go.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[], answer: null as null | (() => Promise<unknown>) }))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => undefined
  },
  invoke: async (cmd: string, args?: unknown) => {
    tauri.calls.push({ cmd, args })
    if (cmd === 'check_plate' && tauri.answer) return tauri.answer()
    return null
  },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }))

const { createTauriSlicer } = await import('../src/host/slicer')

const hit = { kind: 'hotend', severity: 'hit', part: 'toolhead', objectId: 'b', hitId: 'a', layer: 0, segment: 0, timeS: 0, lastLayer: 3, at: [0, 0, 0], point: [0, 0, 0], worstLayer: 0, worstPoint: [0, 0, 0], depthMm: 2, hitHeightMm: 10 }
const found = { collisions: [hit], collisionFixes: [{ kind: 'by_layer', costS: 0, clears: [0], oneClick: true }], certainty: ['sure'], unchecked: [{ objectId: 'a', what: 'tool_change_trips', near: ['b'] }], order: ['a', 'b'], micros: 812 }
const req = { plate: { objects: [{ id: 'a', name: 'a', mesh: '7', transform: [] }] }, config: { print_sequence: 'by object' } } as never

beforeEach(() => {
  tauri.calls.length = 0
  tauri.answer = null
})

describe('the desktop plate check', () => {
  it('sends the request with the meshes by number and reads the answer as the contract has it', async () => {
    tauri.answer = async () => found
    const slicer = createTauriSlicer()
    expect(slicer.checkPlate).toBeTypeOf('function')
    const r = await slicer.checkPlate!(req)
    expect(r).toEqual(found)
    const call = tauri.calls.find((c) => c.cmd === 'check_plate')!.args as { request: string; job: number }
    expect(JSON.parse(call.request).plate.objects[0].mesh).toBe(7)
    expect(JSON.parse(call.request).config).toEqual({ print_sequence: 'by object' })
  })

  it('numbers each check after the last, so the shell can skip one a newer check overtook', async () => {
    tauri.answer = async () => found
    const slicer = createTauriSlicer()
    await slicer.checkPlate!(req)
    await slicer.checkPlate!(req)
    const jobs = tauri.calls.filter((c) => c.cmd === 'check_plate').map((c) => (c.args as { job: number }).job)
    expect(jobs[1]!).toBeGreaterThan(jobs[0]!)
  })

  it('lets the answer go once aborted, and never asks when aborted before', async () => {
    const ac = new AbortController()
    tauri.answer = () => new Promise((resolve) => setTimeout(() => resolve(found), 10))
    const p = createTauriSlicer().checkPlate!(req, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    tauri.calls.length = 0
    await expect(createTauriSlicer().checkPlate!(req, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(tauri.calls).toEqual([])
  })

  it('refuses an answer whose certainty does not match its collisions one for one', async () => {
    tauri.answer = async () => ({ ...found, certainty: [] })
    await expect(createTauriSlicer().checkPlate!(req)).rejects.toThrow(/certainty/)
    tauri.answer = async () => ({ ...found, certainty: ['maybe'] })
    await expect(createTauriSlicer().checkPlate!(req)).rejects.toThrow(/certainty/)
  })
})
