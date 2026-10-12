// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app link's page side: its methods are exactly the hub's pinned list, each call answers from the plate, the
// hub's question reaches the person, and only their buttons answer it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerAsk, hostAppLink, linkAsks } from '../src/app-link/host'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { AppLinkPrompt } from '../src/app-link/prompt'
import type { BridgeAppLink } from '../src/link/bridge'
import { set } from '../src/state/store'

/** The hub's pinned list, read from roles.rs. */
function hubMethods(): Record<string, string> {
  const src = readFileSync(join(__dirname, '../../connect/link/src/roles.rs'), 'utf8')
  const block = /APP_LINK_METHODS: &\[\(&str, LinkClass\)\] = &\[([\s\S]*?)\];/.exec(src)?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/\("([^"]+)",\s*LinkClass::(Read|Edit)\)/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]))
}

function fakeLink() {
  let onCall: Parameters<BridgeAppLink['onCall']>[0] = () => undefined
  let onAsk: Parameters<BridgeAppLink['onAsk']>[0] = () => undefined
  const link = {
    isOn: vi.fn(async () => true),
    setOn: vi.fn(async (on: boolean) => on),
    host: vi.fn(async () => ({ on: true })),
    onCall: vi.fn((cb: typeof onCall) => {
      onCall = cb
      return () => undefined
    }),
    onAsk: vi.fn((cb: typeof onAsk) => {
      onAsk = cb
      return () => undefined
    }),
    reply: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    grants: vi.fn(async () => []),
    revoke: vi.fn(async () => undefined),
  } satisfies BridgeAppLink
  return { link, call: (c: Parameters<typeof onCall>[0]) => onCall(c), ask: (a: Parameters<typeof onAsk>[0]) => onAsk(a) }
}

const box = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 5]), indices: new Uint32Array([0, 1, 2, 0, 1, 3]), name: 'Box', slot: 1 }
const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 50, 0, 1]

beforeEach(() => set({ plate: [{ id: 'obj_1', name: 'Box', parts: [box], transform: moved } as never] }))
afterEach(() => {
  cleanup()
  linkAsks.setState({ asks: [], link: null })
})

describe('app link methods', () => {
  it('are exactly the hub pinned list, with the same classes', () => {
    expect(Object.keys(hubMethods()).length).toBeGreaterThan(0)
    expect(APP_LINK_METHODS).toEqual(hubMethods())
  })

  it('list the plate with each object\'s transform and size', async () => {
    const out = (await runCall('plate.list', {})) as { objects: { id: string; sizeMm: number[]; minMm: number[] }[] }
    expect(out.objects).toEqual([expect.objectContaining({ id: 'obj_1', name: 'Box', parts: 1, sizeMm: [10, 20, 5], minMm: [100, 50, 0] })])
    expect(await runCall('app.info', {})).toMatchObject({ objects: 1, methods: APP_LINK_METHODS })
  })

  it('refuse a name they do not have, including object keys', async () => {
    for (const m of ['print.local', '__proto__', 'constructor', 'toString']) {
      const e = await runCall(m, {}).catch((x: unknown) => x)
      expect(e, m).toBeInstanceOf(LinkError)
      expect((e as LinkError).code).toBe('not_found')
    }
  })
})

describe('hosting the link', () => {
  it('answers the hub\'s calls and passes errors on with their code', async () => {
    const f = fakeLink()
    const stop = hostAppLink(f.link)
    expect(f.link.host).toHaveBeenCalled()
    f.call({ callId: 4, method: 'plate.list', args: {}, client: { id: 'c1', name: 'Claude Code' } })
    await vi.waitFor(() => expect(f.link.reply).toHaveBeenCalledWith(4, { ok: true, value: expect.objectContaining({ objects: expect.any(Array) }) }))
    f.call({ callId: 5, method: 'nope', args: {}, client: { id: 'c1', name: 'Claude Code' } })
    await vi.waitFor(() => expect(f.link.reply).toHaveBeenCalledWith(5, expect.objectContaining({ ok: false, code: 'not_found' })))
    stop()
  })

  it('puts the hub\'s question in front of the person, and only their buttons answer it', async () => {
    const f = fakeLink()
    hostAppLink(f.link)
    act(() => f.ask({ askId: 7, clientId: 'c1', name: 'Claude Code' }))
    render(<AppLinkPrompt />)
    expect(screen.getByText('Claude Code wants to use the open project')).toBeTruthy()
    for (const id of ['app-link-allow', 'app-link-read', 'app-link-deny']) expect(screen.getByTestId(id).hasAttribute('data-agent-refuse'), id).toBe(true)
    fireEvent.click(screen.getByTestId('app-link-read'))
    await vi.waitFor(() => expect(f.link.answer).toHaveBeenCalledWith(7, 'read'))
    expect(screen.queryByTestId('app-link-prompt')).toBeNull()
  })

  it('asks once per client, and a newer question replaces an older one', async () => {
    const f = fakeLink()
    hostAppLink(f.link)
    f.ask({ askId: 1, clientId: 'c1', name: 'A' })
    f.ask({ askId: 2, clientId: 'c1', name: 'A' })
    f.ask({ askId: 3, clientId: 'c2', name: 'B' })
    expect(linkAsks.getState().asks.map((a) => a.askId)).toEqual([2, 3])
    await answerAsk(linkAsks.getState().asks[0]!, 'deny')
    expect(f.link.answer).toHaveBeenCalledWith(2, 'deny')
    expect(linkAsks.getState().asks.map((a) => a.askId)).toEqual([3])
  })
})
