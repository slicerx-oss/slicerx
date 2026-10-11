// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { ShellBridge } from '../src/host/auth'
import { onVaultLink } from '../src/host/vault-link'

/** A shell that holds Vault links like the real one: taken once, announced by an event. */
function fakeShell(waiting: string[]) {
  const listeners = new Set<() => void>()
  const bridge: ShellBridge = {
    invoke: (async (cmd: string) => (cmd === 'vault_link_take' ? waiting.splice(0) : undefined)) as ShellBridge['invoke'],
    listen: async (event, cb) => {
      expect(event).toBe('sx-open-vault')
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return {
    bridge: async () => bridge,
    arrive(slug: string) {
      waiting.push(slug)
      listeners.forEach((cb) => cb())
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('Vault links on the desktop', () => {
  it('hands over the link that started the app, then each new one, once each', async () => {
    const shell = fakeShell(['x-mark'])
    const seen: string[] = []
    const stop = onVaultLink((s) => seen.push(s), shell.bridge)
    await settle()
    expect(seen).toEqual(['x-mark'])
    shell.arrive('temperature-tower')
    await settle()
    expect(seen).toEqual(['x-mark', 'temperature-tower'])
    stop()
    shell.arrive('cable-clip')
    await settle()
    expect(seen).toEqual(['x-mark', 'temperature-tower'])
  })
})
