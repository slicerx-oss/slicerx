// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A STEP read that never ends: the worker is a stub that never answers. The deadline stops it, Cancel stops it, both
// end the worker, and the next STEP file gets a fresh worker that reads it. addFileRefs is the one open that picked
// files, drops and files the system hands over (a double click, an MCP client's open in app) all go through, so the
// last test opens a STEP file that way and checks the person gets a plain message, not a wait that never ends.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileRef, Host } from '@slicerx/contracts'

const RESULT = { base64: '', notes: [], triangles: 12, toleranceMm: 0.01, unit: 'millimeter' }

class StubWorker {
  static made: StubWorker[] = []
  /** 'never': the read never ends; 'ok': it answers at once. */
  static answer: 'never' | 'ok' = 'never'
  terminated = false
  posted: { id: number; name: string }[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  constructor() {
    StubWorker.made.push(this)
  }
  postMessage(msg: { id: number; name: string }): void {
    this.posted.push(msg)
    if (StubWorker.answer === 'ok') void Promise.resolve().then(() => this.onmessage?.({ data: { id: msg.id, result: RESULT } }))
  }
  terminate(): void {
    this.terminated = true
  }
}

const MB = 1024 * 1024
const bytes = (n: number) => new ArrayBuffer(n)

async function load() {
  const step = await import('../src/state/import-step')
  const reading = await import('../src/state/step-reading')
  return { ...step, ...reading }
}

// The open loads its modules on demand, and each test resets them. A cold worker on a busy machine takes tens of seconds to
// transform them the first time, so do that once before the first test; the wait in open() allows for the reloads.
beforeAll(async () => void (await Promise.all([import('../src/state/actions'), import('../src/state/open-models'), import('../src/state/import-step')])))

beforeEach(() => {
  vi.resetModules()
  StubWorker.made = []
  StubWorker.answer = 'never'
  vi.stubGlobal('Worker', StubWorker)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a STEP read that never ends', () => {
  it('gets a minute plus 2 s per megabyte', async () => {
    const { stepDeadlineMs } = await load()
    expect(stepDeadlineMs(0)).toBe(60_000)
    expect(stepDeadlineMs(1)).toBe(62_000)
    expect(stepDeadlineMs(10 * MB)).toBe(80_000)
    expect(stepDeadlineMs(100 * MB)).toBe(260_000)
  })

  it('is stopped at its deadline: the worker ends and the reason is plain', async () => {
    const { convertStep, stepDeadlineMs, stepReading } = await load()
    const read = convertStep({ name: 'bracket.step', data: bytes(3 * MB) })
    const settled = read.then(
      () => 'resolved',
      (e: Error) => e.message,
    )
    expect(stepReading()?.name).toBe('bracket.step')
    await vi.advanceTimersByTimeAsync(stepDeadlineMs(3 * MB) - 1)
    expect(StubWorker.made[0]!.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toBe('took longer than 66 seconds to read, so reading it was stopped. It may be too detailed or damaged. Try exporting it again from your CAD program.')
    expect(StubWorker.made[0]!.terminated).toBe(true)
    expect(stepReading()).toBeNull()
  })

  it('is stopped by Cancel, and so is a file waiting behind it', async () => {
    const { cancelStepRead, convertStep, stepReading, stepCanceledReason } = await load()
    const first = convertStep({ name: 'first.step', data: bytes(10) }).catch((e: Error) => e.message)
    const second = convertStep({ name: 'second.stp', data: bytes(10) }).catch((e: Error) => e.message)
    // One worker reads both, in turn; the bar names the newest.
    expect(StubWorker.made).toHaveLength(1)
    expect(stepReading()?.name).toBe('second.stp')
    cancelStepRead()
    expect(await first).toBe(stepCanceledReason)
    expect(await second).toBe(stepCanceledReason)
    expect(StubWorker.made[0]!.terminated).toBe(true)
    expect(stepReading()).toBeNull()
  })

  it('takes a file waiting behind a stuck one down with a reason of its own', async () => {
    const { convertStep, stepBehindReason, stepDeadlineMs } = await load()
    const first = convertStep({ name: 'first.step', data: bytes(10) }).catch((e: Error) => e.message)
    const second = convertStep({ name: 'second.step', data: bytes(10) }).catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(stepDeadlineMs(10))
    expect(await first).toMatch(/^took longer than 62 seconds to read/)
    expect(await second).toBe(stepBehindReason)
  })

  it('leaves the next STEP file a fresh worker that reads it', async () => {
    const { cancelStepRead, convertStep, stepDeadlineMs, stepReading } = await load()
    const stuck = convertStep({ name: 'stuck.step', data: bytes(10) }).catch(() => 'stopped')
    await vi.advanceTimersByTimeAsync(stepDeadlineMs(10))
    expect(await stuck).toBe('stopped')
    const canceled = convertStep({ name: 'stuck-again.step', data: bytes(10) }).catch(() => 'stopped')
    cancelStepRead()
    expect(await canceled).toBe('stopped')
    StubWorker.answer = 'ok'
    await expect(convertStep({ name: 'good.step', data: bytes(10) })).resolves.toEqual(RESULT)
    expect(StubWorker.made).toHaveLength(3)
    expect(StubWorker.made.map((w) => w.terminated)).toEqual([true, true, false])
    expect(StubWorker.made[2]!.posted.map((m) => m.name)).toEqual(['good.step'])
    expect(stepReading()).toBeNull()
  })

  it('Cancel with nothing being read does nothing', async () => {
    const { cancelStepRead, stepReading } = await load()
    expect(() => cancelStepRead()).not.toThrow()
    expect(stepReading()).toBeNull()
    expect(StubWorker.made).toHaveLength(0)
  })
})

describe('opening a STEP file that never finishes reading', () => {
  const ref: FileRef = { id: '1', name: 'bracket.step', size: 2 * MB, path: '/home/someone/Downloads/bracket.step' }
  const host = { kind: 'desktop', capabilities: { threads: 1 }, files: { read: async () => bytes(2 * MB) }, slicer: {} } as unknown as Host

  async function open() {
    const { addFileRefs } = await import('../src/state/actions')
    const { get, set } = await import('../src/state/store')
    set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', selection: null, selectedIds: [], toast: null, unsavedPrompt: null })
    // How a file the system hands over opens (app.tsx: onOpenRequest with 'open' starts a new project).
    const opening = addFileRefs(host, [ref], { fresh: true })
    await vi.waitFor(() => expect(StubWorker.made).toHaveLength(1), { timeout: 45_000 })
    return { opening, get }
  }

  it('says it took too long, and the plate is no longer loading', async () => {
    const { stepDeadlineMs } = await load()
    const { opening, get } = await open()
    expect(get().plateLoading).toBe(true)
    await vi.advanceTimersByTimeAsync(stepDeadlineMs(2 * MB))
    await opening
    expect(get().toast?.text).toBe('bracket.step took longer than 64 seconds to read, so reading it was stopped. It may be too detailed or damaged. Try exporting it again from your CAD program.')
    expect(get().plateLoading).toBe(false)
    expect(StubWorker.made[0]!.terminated).toBe(true)
  })

  it('says it was canceled when the person cancels', async () => {
    const { cancelStepRead, stepReading } = await load()
    const { opening, get } = await open()
    expect(stepReading()?.name).toBe('bracket.step')
    cancelStepRead()
    await opening
    expect(get().toast?.text).toBe('bracket.step was not opened: reading it was canceled.')
    expect(get().plateLoading).toBe(false)
    expect(StubWorker.made[0]!.terminated).toBe(true)
  })
})
