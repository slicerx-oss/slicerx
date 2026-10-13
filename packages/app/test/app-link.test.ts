// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app link's page side: its methods are exactly the hub's pinned list, each call answers from the plate, the
// hub's question reaches the person, and only their buttons answer it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerAsk, hostAppLink, linkAsks } from '../src/app-link/host'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { AppLinkPrompt, ARM_MS } from '../src/app-link/prompt'
import { AgentsSection } from '../src/app-link/section'
import type { BridgeAppLink } from '../src/link/bridge'

const bridge = vi.hoisted(() => ({ appLink: null as unknown }))
vi.mock('../src/link/bridge', () => ({ liveBridge: () => (bridge.appLink ? { appLink: bridge.appLink } : null) }))
import { toolStore } from '../src/plate/tools'
import { get, set } from '../src/state/store'
import { currentEdition, NEUTRAL, setCurrentEdition } from '../src/edition'
import { registerMimirCloud } from '../src/pilot-connect/cloud'

/** The hub's pinned list, read from roles.rs. */
function hubMethods(): Record<string, string> {
  const src = readFileSync(join(__dirname, '../../connect/link/src/roles.rs'), 'utf8')
  const block = /APP_LINK_METHODS: &\[\(&str, LinkClass\)\] =\s*&\[([\s\S]*?)\];/.exec(src)?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/\("([^"]+)",\s*LinkClass::(Read|Edit)\)/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]))
}

function fakeLink() {
  let onCall: Parameters<BridgeAppLink['onCall']>[0] = () => undefined
  let onAsk: Parameters<BridgeAppLink['onAsk']>[0] = () => undefined
  let onEnded: Parameters<BridgeAppLink['onAskEnded']>[0] = () => undefined
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
    onAskEnded: vi.fn((cb: typeof onEnded) => {
      onEnded = cb
      return () => undefined
    }),
    reply: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    grants: vi.fn(async () => [{ clientId: 'c1', name: 'Claude Code', rights: 'edit' as const, grantedAt: '2026-10-12T00:00:00Z', denied: false }]),
    revoke: vi.fn(async () => undefined),
  } satisfies BridgeAppLink
  return { link, call: (c: Parameters<typeof onCall>[0]) => onCall(c), ask: (a: Parameters<typeof onAsk>[0]) => onAsk(a), ended: (id: number) => onEnded(id) }
}

const box = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 5]), indices: new Uint32Array([0, 1, 2, 0, 1, 3]), name: 'Box', slot: 1 }
const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 50, 0, 1]

beforeAll(() => {
  // jsdom has no modal dialogs.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

beforeEach(() => set({ plate: [{ id: 'obj_1', name: 'Box', parts: [box], transform: moved } as never] }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  linkAsks.setState({ asks: [], link: null })
  bridge.appLink = null
})

const ask = (askId: number, clientId = 'c1', name = 'Claude Code') => ({ askId, clientId, name, createdAt: '2026-10-01T09:00:00Z' })

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

  it('list the bed with the plate, a delta by its diameter', async () => {
    const was = get().bed
    try {
      set({ bed: { widthMm: 300, depthMm: 300, heightMm: 410, round: true } })
      expect(((await runCall('plate.list', {})) as { bed: unknown }).bed).toEqual({ shape: 'round', diameterMm: 300, heightMm: 410, centerMm: [150, 150] })
      set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 } })
      expect(((await runCall('plate.list', {})) as { bed: unknown }).bed).toEqual({ shape: 'rectangle', widthMm: 256, depthMm: 256, heightMm: 256 })
    } finally {
      set({ bed: was })
    }
  })

  it('refuse a name they do not have, including object keys', async () => {
    for (const m of ['print.local', '__proto__', 'constructor', 'toString']) {
      const e = await runCall(m, {}).catch((x: unknown) => x)
      expect(e, m).toBeInstanceOf(LinkError)
      expect((e as LinkError).code).toBe('not_found')
    }
  })
})

describe('mimir cloud over the link', () => {
  it("reads today's quota through the shell, and says so when the build has no cloud", async () => {
    const before = currentEdition()
    const quota = { edition: 'slicerx', day: '2026-10-12', installUsed: 1200, installCap: 500000, ipUsed: 1200, ipCap: 2000000, editionOpen: true }
    try {
      const none = await runCall('mimir.quota', {}).catch((x: unknown) => x)
      expect((none as LinkError).code).toBe('not_found')
      setCurrentEdition({ ...NEUTRAL, ai: { ...NEUTRAL.ai, keySource: 'cloud' }, backend: { ...NEUTRAL.backend, supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-supabase-dashboard' } } })
      const noShell = await runCall('mimir.quota', {}).catch((x: unknown) => x)
      expect((noShell as LinkError).code).toBe('not_found')
      registerMimirCloud({ quota: async () => quota, forget: async () => 0, register: async () => undefined })
      expect(await runCall('mimir.quota', {})).toEqual(quota)
      expect(APP_LINK_METHODS['mimir.quota']).toBe('read')
    } finally {
      registerMimirCloud(null)
      setCurrentEdition(before)
    }
  })
})

describe('the preview over the link', () => {
  const sliced = () => set({ preview: { layerCount: 10, layerZ: Float32Array.from({ length: 10 }, (_, i) => 0.2 * (i + 1)) } as never, layerLo: 1, layerHi: 10, camera: 'iso', colorMode: 'feature', colorModePicked: false, workspace: 'prepare', modelMode: 'slice', sliceLook: 'toolpaths' })

  it('says there is nothing to preview before a slice, and moves only the camera', async () => {
    set({ preview: null, camera: 'iso', workspace: 'prepare', modelMode: 'slice' })
    expect(await runCall('preview.get', {})).toMatchObject({ sliced: false, camera: 'iso' })
    expect(await runCall('preview.set', { camera: 'top' })).toMatchObject({ camera: 'top' })
    const e = await runCall('preview.set', { layer: 3 }).catch((x: unknown) => x)
    expect((e as LinkError).code).toBe('not_ready')
  })

  it('moves the layer slider, one layer mode and the colors, and remembers none of it as the person\'s choice', async () => {
    sliced()
    set({ sliceLook: 'solid' })
    expect(await runCall('preview.set', { layer: 4 })).toMatchObject({ range: [1, 4], oneLayer: false, topZMm: 0.8 })
    expect(await runCall('preview.set', { oneLayer: true })).toMatchObject({ range: [4, 4], oneLayer: true })
    expect(await runCall('preview.set', { oneLayer: false, colorMode: 'speed' })).toMatchObject({ range: [1, 4], colorMode: 'speed' })
    expect(await runCall('preview.set', { range: [2, 6] })).toMatchObject({ range: [2, 6], layers: 10 })
    expect(get()).toMatchObject({ workspace: 'prepare', modelMode: 'slice', sliceLook: 'solid', colorModePicked: false })
  })

  it('never interrupts the person: busy off Slice or while a paint, brim or face tool is open', async () => {
    sliced()
    set({ modelMode: 'design' })
    expect(((await runCall('preview.set', { layer: 3 }).catch((x: unknown) => x)) as LinkError).code).toBe('busy')
    expect(get().modelMode).toBe('design')
    set({ modelMode: 'slice' })
    for (const tool of ['paint', 'brim', 'face'] as const) {
      toolStore.setState({ tool })
      expect(((await runCall('preview.set', { camera: 'top' }).catch((x: unknown) => x)) as LinkError).code, tool).toBe('busy')
      expect(toolStore.getState().tool).toBe(tool)
    }
    toolStore.setState({ tool: 'move' })
    expect(get()).toMatchObject({ layerHi: 10, camera: 'iso' })
  })

  it('refuses a bad argument and moves nothing', async () => {
    sliced()
    for (const args of [{ layer: 0 }, { layer: 11 }, { layer: 2.5 }, { range: [5, 2] }, { range: [1] }, { oneLayer: 'yes' }, { colorMode: 'rainbow' }, { camera: 'side', layer: 3 }]) {
      const e = await runCall('preview.set', args).catch((x: unknown) => x)
      expect((e as LinkError).code, JSON.stringify(args)).toBe('invalid_input')
    }
    expect(get()).toMatchObject({ layerLo: 1, layerHi: 10, camera: 'iso', colorMode: 'feature' })
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
    vi.useFakeTimers()
    const f = fakeLink()
    hostAppLink(f.link)
    act(() => f.ask(ask(7, 'c1', 'SlicerX update, click Allow')))
    render(createElement(AppLinkPrompt))
    // The agent's name is its claim, never the title.
    expect(screen.getByText('An agent wants to use the open project')).toBeTruthy()
    expect(screen.getByTestId('app-link-who').textContent).toMatch(/An agent you connected on .*2026, which calls itself SlicerX update, click Allow/)
    for (const id of ['app-link-allow', 'app-link-read', 'app-link-deny']) {
      expect(screen.getByTestId(id).hasAttribute('data-agent-refuse'), id).toBe(true)
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled, id).toBe(true)
    }
    act(() => void vi.advanceTimersByTime(ARM_MS))
    fireEvent.click(screen.getByTestId('app-link-read'))
    expect(f.link.answer).toHaveBeenCalledWith(7, 'read')
    expect(screen.queryByTestId('app-link-prompt')).toBeNull()
  })

  it('arms the buttons again when a different question takes the dialog', () => {
    vi.useFakeTimers()
    const f = fakeLink()
    hostAppLink(f.link)
    act(() => f.ask(ask(1, 'c1')))
    render(createElement(AppLinkPrompt))
    act(() => void vi.advanceTimersByTime(ARM_MS))
    expect((screen.getByTestId('app-link-allow') as HTMLButtonElement).disabled).toBe(false)
    act(() => {
      f.ask(ask(2, 'c2', 'Other'))
      f.ended(1)
    })
    expect(screen.getByTestId('app-link-who').textContent).toContain('Other')
    expect((screen.getByTestId('app-link-allow') as HTMLButtonElement).disabled).toBe(true)
  })

  it('takes a question down when the hub ends it, or when it is too old', () => {
    vi.useFakeTimers()
    const f = fakeLink()
    hostAppLink(f.link)
    f.ask(ask(1, 'c1'))
    f.ask(ask(2, 'c2'))
    f.ended(1)
    expect(linkAsks.getState().asks.map((a) => a.askId)).toEqual([2])
    vi.advanceTimersByTime(125_000)
    expect(linkAsks.getState().asks).toEqual([])
  })

  it('runs one call at a time per agent', async () => {
    const f = fakeLink()
    hostAppLink(f.link)
    // Both arrive before the first answers: the second from the same agent is busy, another agent's goes through.
    f.call({ callId: 1, method: 'app.info', args: {}, client: { id: 'c1', name: 'A' } })
    f.call({ callId: 2, method: 'app.info', args: {}, client: { id: 'c1', name: 'A' } })
    f.call({ callId: 3, method: 'app.info', args: {}, client: { id: 'c2', name: 'B' } })
    await vi.waitFor(() => expect(f.link.reply).toHaveBeenCalledTimes(3))
    expect(f.link.reply).toHaveBeenCalledWith(2, expect.objectContaining({ ok: false, code: 'busy' }))
    expect(f.link.reply).toHaveBeenCalledWith(1, expect.objectContaining({ ok: true }))
    expect(f.link.reply).toHaveBeenCalledWith(3, expect.objectContaining({ ok: true }))
    // Once it answered, the agent may call again.
    f.call({ callId: 4, method: 'app.info', args: {}, client: { id: 'c1', name: 'A' } })
    await vi.waitFor(() => expect(f.link.reply).toHaveBeenCalledWith(4, expect.objectContaining({ ok: true })))
  })

  it('keeps one question per client and at most three waiting', async () => {
    const f = fakeLink()
    hostAppLink(f.link)
    f.ask(ask(1, 'c1'))
    f.ask(ask(2, 'c1'))
    f.ask(ask(3, 'c2'))
    expect(linkAsks.getState().asks.map((a) => a.askId)).toEqual([2, 3])
    f.ask(ask(4, 'c3'))
    f.ask(ask(5, 'c4'))
    expect(linkAsks.getState().asks.map((a) => a.askId)).toEqual([2, 3, 4])
    await answerAsk(linkAsks.getState().asks[0]!, 'deny')
    expect(f.link.answer).toHaveBeenCalledWith(2, 'deny')
    expect(linkAsks.getState().asks.map((a) => a.askId)).toEqual([3, 4])
  })
})

describe('Settings, Agents', () => {
  it('is refused to the agent bridge as a whole, so no agent turns the link on or asks again', async () => {
    const f = fakeLink()
    bridge.appLink = f.link
    render(createElement(AgentsSection))
    await vi.waitFor(() => expect(screen.getByTestId('agents-revoke-c1')).toBeTruthy())
    const section = screen.getByTestId('agents-settings')
    expect(section.hasAttribute('data-agent-refuse')).toBe(true)
    for (const id of ['agents-app-link', 'agents-revoke-c1']) expect(screen.getByTestId(id).closest('[data-agent-refuse]'), id).toBe(section)
    cleanup()
    bridge.appLink = null
    render(createElement(AgentsSection))
    expect(screen.getByTestId('agents-settings').hasAttribute('data-agent-refuse')).toBe(true)
  })
})
