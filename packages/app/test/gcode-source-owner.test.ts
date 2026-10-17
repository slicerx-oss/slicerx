// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { Host } from '@slicerx/contracts'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { set } from '../src/state/store'
import { indexLines, lineText } from '../src/workspaces/preview/gcode-lines'
import { holdText, textHeld, type TextHold } from '../src/workspaces/preview/gcode-source'

const holds: TextHold[] = []
const hold = (host: Host) => { const h = holdText(host); holds.push(h); return h }
beforeEach(() => set({ slice: { status: 'done', result: { id: 'shared-id' } } as never }))
afterEach(() => { for (const h of holds.splice(0)) h.release(); set({ slice: { status: 'idle' } }) })
async function host(text: string): Promise<Host> {
  const ix = await indexLines(new TextEncoder().encode(text))
  return { slicer: { gcodeLineStarts: async () => ix.starts, gcodeBytes: async (_id: string, a: number, b: number) => ix.bytes.slice(a, b) } } as unknown as Host
}

it('does not share slice text across different hosts that use the same slice ID', async () => {
  const first = hold(await host('G1 X1\n'))
  const second = hold(await host('G1 X2\n'))
  const a = await first.source!
  const b = await second.source!
  expect(lineText(await a.window(1, 1), 1)).toBe('G1 X1')
  expect(lineText(await b.window(1, 1), 1)).toBe('G1 X2')
})

it('does not discard a new hold when a released old read with the same slice ID fails', async () => {
  let reject!: (error: Error) => void
  const oldHost = { slicer: { gcodeLineStarts: () => new Promise<Uint32Array>((_r, fail) => { reject = fail }), gcodeBytes: async () => new Uint8Array() } } as unknown as Host
  const first = hold(oldHost)
  first.release()
  const second = hold(await host('G1 X2\n'))
  await second.source
  const failed = expect(first.source).rejects.toThrow('old read failed')
  reject(new Error('old read failed'))
  await failed
  expect(textHeld()).toBe(true)
})
