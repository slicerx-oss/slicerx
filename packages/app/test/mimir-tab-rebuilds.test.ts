// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab keeps its runtime across a trip to the phone layout and back. The layout change takes the built-in
// commands away and loads them again, the same commands as new objects; the runtime is made again only when the setup
// mimir uses really changes (a command it has as a tool is added, removed or changed, Settings > mimir, signing in to
// mimir cloud), and then once.
import type { CommandSpec, Host, MeshHandle, MeshPart } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const made = vi.hoisted(() => ({ count: 0 }))
vi.mock('@slicerx/pilot', async (importOriginal) => {
  const real = await importOriginal<typeof import('@slicerx/pilot')>()
  return {
    ...real,
    createPilot: (...args: Parameters<typeof real.createPilot>) => {
      made.count++
      return real.createPilot(...args)
    },
  }
})

import { registerCommands, registerCommandsLater } from '../src/commands/registry'
import { NEUTRAL } from '../src/edition'
import { registerMimirCloud } from '../src/pilot-connect/cloud'
import { get, set } from '../src/state/store'
import { COMMANDS_WAIT_MS, GONE_REPLY, liveCommands, resetTabMimir, tabMimir } from '../src/workspaces/mimir/session'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { kind: 'desktop', capabilities: {}, slicer: { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }, build: { version: '0.0.0-test' } } as unknown as Host

/** The built-in commands as a layout makes them: the same ids and specs every time, new objects with new closures. */
const ran: string[] = []
function builtins(layout: string): CommandSpec[] {
  return [
    { id: 'open-prepare', title: 'Go to Slice', section: 'navigate', workspace: 'prepare', tool: { permission: 'read' }, run: () => void ran.push(`open-prepare ${layout}`) },
    { id: 'goal-strong', title: 'Goal: Strong', section: 'settings', workspace: 'prepare', tool: { permission: 'slice' }, run: () => void ran.push(`goal-strong ${layout}`) },
    { id: 'theme-dark', title: 'Dark theme', section: 'view', run: () => undefined },
  ]
}

/** What app.tsx does: the built-in commands load after first paint, and register again whenever the layout changes. */
let offBuiltins: (() => void) | null = null
function layoutTo(layout: string): void {
  offBuiltins?.()
  offBuiltins = registerCommandsLater(async () => builtins(layout))
}

/** The chat's hook asking for the runtime after each change it sees, and waiting for it, as useTabMimir does. */
async function settle() {
  const first = await tabMimir(host, NEUTRAL)
  // the commands landing re-renders the chat, which asks again
  await Promise.resolve()
  const again = await tabMimir(host, NEUTRAL)
  return { first, again }
}

describe('the mimir tab runtime across a layout trip', () => {
  const was = { pilot: get().pilot }
  let offs: (() => void)[] = []
  beforeEach(async () => {
    resetTabMimir()
    set({ pilot: { mode: 'unset' } })
    layoutTo('desktop')
    await settle()
    made.count = 0
    ran.length = 0
  })
  afterEach(() => {
    for (const off of offs) off()
    offs = []
    offBuiltins?.()
    offBuiltins = null
    resetTabMimir()
    registerMimirCloud(null)
    set(was)
  })

  it('a trip to the phone layout and back makes no new runtime', async () => {
    const before = await tabMimir(host, NEUTRAL)
    for (let trip = 0; trip < 2; trip++) {
      for (const layout of ['phone', 'desktop']) {
        layoutTo(layout)
        // the chat sees the commands go, then come back
        await settle()
      }
      expect(made.count).toBe(0)
    }
    expect(await tabMimir(host, NEUTRAL)).toBe(before)
  })

  it('the built-in commands registering again with the same specs makes no new runtime, and the runtime runs the new ones', async () => {
    const before = await tabMimir(host, NEUTRAL)
    offs.push(registerCommands(builtins('again')))
    await settle()
    expect(made.count).toBe(0)
    expect(await tabMimir(host, NEUTRAL)).toBe(before)
    // the runtime's app.goal_strong calls the command registered now, not the one it was made with
    const cmd = liveCommands().find((c) => c.id === 'goal-strong')
    await cmd?.run()
    expect(ran).toEqual(['goal-strong again'])
  })

  it("a command the runtime was made with runs only while it is the same, there and on", async () => {
    const [made] = liveCommands().filter((c) => c.id === 'goal-strong')
    const goal = builtins('desktop')[1]!
    // the same command registered again: the live one runs
    let off = registerCommands([{ ...goal, run: () => void ran.push('goal-strong same') }])
    expect(await made!.run()).toBeUndefined()
    expect(ran).toEqual(['goal-strong same'])
    off()
    // a changed one under the same id is refused
    off = registerCommands([{ ...goal, title: 'Goal: Stronger', run: () => void ran.push('goal-strong changed') }])
    expect(await made!.run()).toEqual({ status: 'error', message: GONE_REPLY })
    off()
    // gone: refused the same way
    offBuiltins?.()
    offBuiltins = null
    expect(await made!.run()).toEqual({ status: 'error', message: GONE_REPLY })
    // the same command turned off is refused
    off = registerCommands([{ ...goal, enabled: () => false, run: () => void ran.push('goal-strong off') }])
    expect(await made!.run()).toEqual({ status: 'error', message: 'Goal: Strong is not available right now.' })
    off()
    expect(ran).toEqual(['goal-strong same'])
  })

  it('commands that never finish loading hold the runtime back only a short while', async () => {
    resetTabMimir()
    let release: () => void = () => undefined
    const off = registerCommandsLater(() => new Promise<readonly CommandSpec[]>((resolve) => (release = () => resolve([]))))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let done = false
      const p = tabMimir(host, NEUTRAL).then((pilot) => ((done = true), pilot))
      await vi.advanceTimersByTimeAsync(COMMANDS_WAIT_MS - 100)
      expect(done).toBe(false)
      expect(made.count).toBe(0)
      await vi.advanceTimersByTimeAsync(200)
      expect(await p).toBeTruthy()
      expect(made.count).toBe(1)
    } finally {
      vi.useRealTimers()
      release()
      off()
    }
  })

  it('a command mimir has as a tool arriving (pairing a printer) makes the runtime again, once', async () => {
    const before = await tabMimir(host, NEUTRAL)
    offs.push(registerCommands([{ id: 'printer-a1-pause', title: 'Pause A1', section: 'printers', tool: { permission: 'queue' }, run: () => undefined }]))
    const { first, again } = await settle()
    expect(made.count).toBe(1)
    expect(first).not.toBe(before)
    expect(again).toBe(first)
  })

  it('a command mimir has as a tool changing its spec makes the runtime again, once', async () => {
    offs.push(registerCommands([{ ...builtins('desktop')[1]!, tool: { permission: 'slice', inputSchema: { type: 'object', properties: { strength: { type: 'number' } } } } }]))
    await settle()
    await settle()
    expect(made.count).toBe(1)
  })

  it('a command mimir does not have as a tool changes nothing', async () => {
    offs.push(registerCommands([{ id: 'theme-light', title: 'Light theme', section: 'view', run: () => undefined }]))
    await settle()
    expect(made.count).toBe(0)
  })

  it('Settings > mimir changing makes the runtime again, once, and a layout trip after it none', async () => {
    set({ pilot: { mode: 'off' } })
    await settle()
    await settle()
    expect(made.count).toBe(1)
    layoutTo('phone')
    await settle()
    layoutTo('desktop')
    await settle()
    expect(made.count).toBe(1)
  })
})
