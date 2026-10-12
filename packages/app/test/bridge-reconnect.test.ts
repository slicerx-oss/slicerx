// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A bridge connection that drops comes back on its own on the desktop, and a printer call after that works. A send
// that dropped part way is never sent again: the printer is asked what it is doing and the note says that.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalHost, Host, PrinterHost, PrinterStatus } from '@slicerx/contracts'
import { connectBridge, disconnectBridge, RECONNECT_DELAYS_MS, resetBridge, setBridgeConnector, type ConnectedBridge } from '../src/link/bridge'
import { droppedSendNote, isDroppedConnection } from '../src/link/dropped-send'
import { appState } from '../src/agent-bridge/page'
import { get } from '../src/state/store'

function host(): Host {
  return { printers: undefined, approvals: { id: 'none' }, secrets: { id: 'none' }, capabilities: { printers: 'sim', secureStorage: false } } as unknown as Host
}

const closedError = () => Object.assign(new Error('The sx-link connection closed'), { code: 'closed' })

/** A bridge whose connection can be dropped from the test; its printers answer with `status`. */
function droppable(status: () => PrinterStatus, starts: string[]) {
  let drop: ((info: { requested: boolean }) => void) | null = null
  let down = false
  const printers = {
    list: async () => (down ? Promise.reject(closedError()) : [{ id: 'p1', name: 'A1 mini' }]),
    status: async () => (down ? Promise.reject(closedError()) : status()),
    start: async (file: { name: string }) => {
      starts.push(file.name)
      throw closedError()
    },
  } as unknown as PrinterHost
  const bridge: ConnectedBridge = {
    printers,
    approvals: { id: 'link-approvals' } as unknown as ApprovalHost,
    streams: { open: async () => Promise.reject(new Error('none')) },
    setup: { discover: async () => [], testConnection: async () => ({ ok: true, steps: [] }), addPrinter: async () => ({ printerId: 'p1' }) },
    onDisconnect: (cb) => {
      drop = cb
      return () => void (drop = null)
    },
    close: () => drop?.({ requested: true }),
  }
  return {
    bridge,
    dropNow: () => {
      down = true
      drop?.({ requested: false })
    },
  }
}

beforeEach(() => {
  resetBridge()
  setBridgeConnector(null)
  RECONNECT_DELAYS_MS.splice(0, RECONNECT_DELAYS_MS.length, 5, 10, 20)
})
afterEach(async () => {
  resetBridge()
  RECONNECT_DELAYS_MS.splice(0, RECONNECT_DELAYS_MS.length, 500, 1000, 2000, 4000, 8000, 15000)
  await vi.dynamicImportSettled()
})

const idle = (): PrinterStatus => ({ printerId: 'p1', state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: new Date(0).toISOString() }) as PrinterStatus

describe('a dropped bridge connection', () => {
  it('reconnects on the desktop, and a printer call after that succeeds', async () => {
    const starts: string[] = []
    const made: ReturnType<typeof droppable>[] = []
    let failures = 1
    setBridgeConnector({
      automatic: true,
      connect: async () => {
        // The first try after the drop finds the hub still away; the next one gets through.
        if (made.length === 1 && failures-- > 0) throw new Error('hub not answering')
        const b = droppable(idle, starts)
        made.push(b)
        return b.bridge
      },
    })
    const h = host()
    expect(await connectBridge(h)).toBe(true)
    const epoch = get().linkEpoch
    made[0]!.dropNow()
    expect(get().bridgeStatus.state).toBe('reconnecting')
    // A client reading the app back sees it too: the cards' controls are off until the bridge is back.
    expect(appState(get()).printerBridge).toEqual({ state: 'reconnecting', attempt: 1, cardsDisabled: true })
    // Until it is back, printer calls fail as closed; no other printers stand in for the bridge's.
    await expect(h.printers!.status('p1')).rejects.toMatchObject({ code: 'closed' })
    await vi.waitFor(() => expect(get().bridgeStatus.state).toBe('on'), { timeout: 2000 })
    expect(made).toHaveLength(2)
    expect(get().linkEpoch).toBeGreaterThan(epoch)
    expect((await h.printers!.status('p1')).state).toBe('idle')
  })

  it('in a browser asks to connect again instead of trying on its own', async () => {
    const made: ReturnType<typeof droppable>[] = []
    setBridgeConnector({
      automatic: false,
      connect: async () => {
        const b = droppable(idle, [])
        made.push(b)
        return b.bridge
      },
    })
    const h = host()
    expect(await connectBridge(h, 'CODE1234')).toBe(true)
    made[0]!.dropNow()
    expect(get().bridgeStatus).toEqual({ state: 'error', message: 'The connection to the printer bridge closed. Connect again.' })
    await new Promise((r) => setTimeout(r, 60))
    expect(made).toHaveLength(1)
  })

  it('stops reconnecting when the person disconnects', async () => {
    const made: ReturnType<typeof droppable>[] = []
    setBridgeConnector({
      automatic: true,
      connect: async () => {
        if (made.length >= 1) throw new Error('hub not answering')
        const b = droppable(idle, [])
        made.push(b)
        return b.bridge
      },
    })
    const h = host()
    await connectBridge(h)
    made[0]!.dropNow()
    disconnectBridge(h)
    expect(get().bridgeStatus.state).toBe('off')
    // What the host had before the bridge is back.
    expect(h.printers).toBeUndefined()
    expect(h.capabilities.printers).toBe('sim')
    await new Promise((r) => setTimeout(r, 80))
    expect(get().bridgeStatus.state).toBe('off')
  })
})

describe('a send that dropped part way', () => {
  it('is never sent again: the note says what the printer reports once the bridge is back', async () => {
    const starts: string[] = []
    const made: ReturnType<typeof droppable>[] = []
    let state: PrinterStatus = { ...idle(), state: 'printing', jobName: 'plate.gcode.3mf' }
    setBridgeConnector({
      automatic: true,
      connect: async () => {
        const b = droppable(() => state, starts)
        made.push(b)
        return b.bridge
      },
    })
    const h = host()
    await connectBridge(h)
    // The start goes out, and the connection drops before its answer comes back.
    const sending = h.printers!.start({ printerId: 'p1', name: 'plate.gcode.3mf' } as never, {} as never, { id: 't' } as never)
    made[0]!.dropNow()
    const e = await sending.catch((x: unknown) => x)
    expect(isDroppedConnection(e)).toBe(true)
    const note = await droppedSendNote(h, 'p1', 'A1 mini', 'plate.gcode.3mf', 2000)
    expect(note).toContain('A1 mini is printing plate.gcode.3mf: the print started before the connection dropped.')
    expect(note).toContain('was not sent again')
    expect(starts).toEqual(['plate.gcode.3mf'])

    // A printer that did not start reports its state; still nothing is sent.
    state = idle()
    const second = await droppedSendNote(h, 'p1', 'A1 mini', 'plate.gcode.3mf', 2000)
    expect(second).toContain('The printer reports that it is idle. Send again if you still want this print.')
    expect(starts).toEqual(['plate.gcode.3mf'])
  })

  it('says so when the bridge does not come back in time', async () => {
    setBridgeConnector({ automatic: true, connect: async () => Promise.reject(new Error('hub not answering')) })
    const made = droppable(idle, [])
    setBridgeConnector({ automatic: true, connect: async () => made.bridge })
    const h = host()
    await connectBridge(h)
    setBridgeConnector({ automatic: true, connect: async () => Promise.reject(new Error('hub not answering')) })
    made.dropNow()
    const note = await droppedSendNote(h, 'p1', 'A1 mini', 'plate.gcode.3mf', 50)
    expect(note).toContain('The bridge has not come back yet. Check the printer before you send again.')
  })
})
