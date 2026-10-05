// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { agentKeyRef, browserHost, installAgent, type AgentInstallHost } from '../src/pilot-connect/agents'

const HUB_KEY = 'aGVsbG8gaHViIGtleQ=='

function host(over: Partial<AgentInstallHost> = {}): { host: AgentInstallHost; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    host: {
      serverCommand: async () => ({ command: 'node', args: ['/Applications/SlicerX.app/Contents/Resources/mcp/dist/cli.js'] }),
      hub: async () => ({ hubKey: HUB_KEY, linkUrl: 'ws://127.0.0.1:47615' }),
      credential: async (client) => {
        calls.push(`credential ${client}`)
        return { ok: true }
      },
      run: async (client, step) => {
        calls.push(`run ${client} ${step.kind}`)
        return { ok: true, message: step.kind === 'command' ? step.text : 'done' }
      },
      ...over,
    },
  }
}

describe('connect your AI agent', () => {
  it('gets the credential first, then runs the one-click step with the keychain name and the pinned hub key', async () => {
    const h = host()
    const r = await installAgent(h.host, 'claude-code')
    expect(h.calls).toEqual(['credential claude-code', 'run claude-code command'])
    expect(r.ok).toBe(true)
    expect(r.message).toContain(agentKeyRef('claude-code'))
    expect(r.message).toContain(HUB_KEY)
    expect(r.message).toContain('/Applications/SlicerX.app/Contents/Resources/mcp/dist/cli.js')
    // The config entry names where the key lives. No field carries a key.
    expect(r.paste).toContain('SLICERX_MCP_LINK_KEY_REF')
    expect(JSON.stringify(r)).not.toMatch(/clientKey|[0-9a-f]{64}/)
  })

  it('runs nothing when the hub hands out no credential, and still shows the entry', async () => {
    const h = host({ credential: async () => ({ ok: false, reason: 'The printer bridge is not running.' }) })
    const r = await installAgent(h.host, 'cursor')
    expect(h.calls).toEqual([])
    expect(r).toMatchObject({ ok: false, message: 'The printer bridge is not running.', pasteInto: '~/.cursor/mcp.json' })
  })

  it('opens a link for Cursor and waits for the relay for ChatGPT', async () => {
    const h = host()
    await installAgent(h.host, 'cursor')
    expect(h.calls).toEqual(['credential cursor', 'run cursor deeplink'])
    const r = await installAgent(h.host, 'chatgpt')
    expect(r.ok).toBe(false)
    expect(h.calls).toHaveLength(2)
  })

  it('in the browser asks for no credential and points at the desktop app', async () => {
    const r = await installAgent(browserHost, 'codex')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('desktop app')
    expect(r.paste).toContain('[mcp_servers.slicerx]')
  })
})
