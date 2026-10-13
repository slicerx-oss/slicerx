// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Moving, turning and scaling objects over the app link: each call lands on the shown plate as one undo step, reads
// back through plate.list, tells the person which agent did it, and never touches what is locked or being edited.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAppLink } from '../src/app-link/host'
import { LinkError, runCall } from '../src/app-link/methods'
import type { BridgeAppLink } from '../src/link/bridge'
import { history } from '../src/plate/history'
import { get, set } from '../src/state/store'

const box = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 5]), indices: new Uint32Array([0, 1, 2, 0, 1, 3]), name: 'Box', slot: 1 }
const at = (x: number, y: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]

type Read = { objects: { id: string; minMm: number[]; sizeMm: number[] }[] }
const read = async (id: string) => ((await runCall('plate.list', {})) as Read).objects.find((o) => o.id === id)!
const code = async (p: Promise<unknown>) => ((await p.catch((x: unknown) => x)) as LinkError).code

beforeEach(() => {
  history().clear()
  set({
    bed: { widthMm: 256, depthMm: 256, heightMm: 256 },
    plate: [{ id: 'obj_1', name: 'Box', parts: [box], transform: at(100, 50) } as never, { id: 'obj_1~c', name: 'Box', instanceOf: 'obj_1', parts: [box], transform: at(150, 50) } as never],
    historyEdit: null,
    toast: null,
  })
})
afterEach(() => vi.useRealTimers())

describe('plate edits over the app link', () => {
  it('move an object by its footprint center, by name or id, and read it back', async () => {
    const out = (await runCall('project.move', { object: 'Box', x: 50, y: 60 }, 'Print Helper')) as Read
    expect(out.objects).toEqual([expect.objectContaining({ id: 'obj_1', minMm: [45, 50, 0], sizeMm: [10, 20, 5] })])
    expect((await read('obj_1')).minMm).toEqual([45, 50, 0])
    // Its copy stays where it is.
    expect((await read('obj_1~c')).minMm).toEqual([150, 50, 0])
    await runCall('project.move', { object: 'obj_1~c', x: 200, y: 200 })
    expect((await read('obj_1~c')).minMm).toEqual([195, 190, 0])
  })

  it('turn and scale the object with its copies, about their own centers and back on the bed', async () => {
    await runCall('project.rotate', { object: 'Box', rotate: [0, 0, 90] })
    expect(await read('obj_1')).toMatchObject({ minMm: [95, 55, 0], sizeMm: [20, 10, 5] })
    expect((await read('obj_1~c')).sizeMm).toEqual([20, 10, 5])
    await runCall('project.rotate', { object: 'Box', rotate: [0, 0, 0] })
    await runCall('project.scale', { object: 'obj_1', scale: 2 })
    expect(await read('obj_1')).toMatchObject({ minMm: [95, 40, 0], sizeMm: [20, 40, 10] })
    expect((await read('obj_1~c')).sizeMm).toEqual([20, 40, 10])
    await runCall('project.scale', { object: 'Box', scale: [1, 1, 3] })
    expect((await read('obj_1')).sizeMm).toEqual([10, 20, 15])
  })

  it('put an object in free space with auto', async () => {
    const out = (await runCall('project.move', { object: 'Box', auto: true })) as Read
    const [x = 0, y = 0] = out.objects[0]!.minMm
    const [w = 0, d = 0] = out.objects[0]!.sizeMm
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x + w).toBeLessThanOrEqual(256)
    // Clear of its copy.
    expect(x + w <= 150 || x >= 160 || y >= 70 || y + d <= 50).toBe(true)
  })

  it('are one undo step each, and the person sees which agent did it with Undo', async () => {
    const f = fakeLink()
    const stop = hostAppLink(f.link)
    f.call({ callId: 1, method: 'project.move', args: { object: 'Box', x: 50, y: 60 }, client: { id: 'c1', name: 'Print Helper' } })
    await vi.waitFor(() => expect(f.link.reply).toHaveBeenCalledWith(1, { ok: true, value: expect.objectContaining({ objects: expect.any(Array) }) }))
    expect(get().toast).toMatchObject({ text: 'Print Helper moved Box.', action: { label: 'Undo' } })
    f.call({ callId: 2, method: 'project.scale', args: { object: 'Box', scale: 2 }, client: { id: 'c1', name: 'Print Helper' } })
    await vi.waitFor(() => expect(f.link.reply).toHaveBeenCalledWith(2, expect.objectContaining({ ok: true })))
    expect(get().toast?.text).toBe('Print Helper scaled Box.')
    get().toast?.action?.run()
    expect((await read('obj_1')).sizeMm).toEqual([10, 20, 5])
    expect((await read('obj_1')).minMm).toEqual([45, 50, 0])
    history().undo()
    expect((await read('obj_1')).minMm).toEqual([100, 50, 0])
    stop()
  })

  it('refuse what is locked or being edited, and changes nothing', async () => {
    const before = get().plate
    set({ plate: before.map((e) => (e.id === 'obj_1' ? { ...e, locked: true } : e)) })
    expect(await code(runCall('project.move', { object: 'obj_1', x: 0, y: 0 }))).toBe('refused')
    set({ plate: before, historyEdit: { objectId: 'obj_1' } as never })
    expect(await code(runCall('project.rotate', { object: 'Box', rotate: [0, 0, 90] }))).toBe('busy')
    expect(get().plate).toBe(before)
  })

  it('check the object and the numbers before anything moves', async () => {
    expect(await code(runCall('project.move', { object: 'Nope', x: 0, y: 0 }))).toBe('not_found')
    expect(await code(runCall('project.move', { object: 'Box', x: 1 }))).toBe('invalid_input')
    expect(await code(runCall('project.rotate', { object: 'Box', rotate: [0, 90] }))).toBe('invalid_input')
    for (const scale of [0, -1, 101, [1, 1], 'big']) expect(await code(runCall('project.scale', { object: 'Box', scale })), String(scale)).toBe('invalid_input')
    // Two objects with one name: the agent names one by id.
    set({ plate: [...get().plate, { id: 'obj_2', name: 'Box', parts: [box], transform: at(10, 10) } as never] })
    const e = (await runCall('project.move', { object: 'Box', x: 0, y: 0 }).catch((x: unknown) => x)) as LinkError
    expect(e.code).toBe('invalid_input')
    expect(e.message).toMatch(/obj_1, obj_2/)
  })
})

function fakeLink() {
  let onCall: Parameters<BridgeAppLink['onCall']>[0] = () => undefined
  const none = () => () => undefined
  const link = {
    isOn: vi.fn(async () => true),
    setOn: vi.fn(async (on: boolean) => on),
    host: vi.fn(async () => ({ on: true })),
    onCall: vi.fn((cb: typeof onCall) => {
      onCall = cb
      return () => undefined
    }),
    onAsk: vi.fn(none),
    onAskEnded: vi.fn(none),
    reply: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    grants: vi.fn(async () => []),
    revoke: vi.fn(async () => undefined),
  } satisfies BridgeAppLink
  return { link, call: (c: Parameters<typeof onCall>[0]) => onCall(c) }
}
