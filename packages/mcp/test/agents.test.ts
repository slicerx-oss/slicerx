// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { AGENT_CLIENTS, agentKeyRef, installSteps, type InstallInput } from '../src/agents'
import { readKeychainKey } from '../src/link-code'

const input: InstallInput = { server: { command: 'node', args: ['/Applications/SlicerX.app/Contents/Resources/mcp/cli.js'] }, hubKey: 'HUBKEYBASE64=' }

describe('Connect your AI agent', () => {
  it("lists a white-label edition's server under its own name", () => {
    const acme: InstallInput = { ...input, app: { id: 'acmeslicer', name: 'Acme Slicer', author: { name: 'Acme Printers Inc.' } } }
    const steps = (['claude-desktop', 'claude-code', 'cursor', 'codex', 'chatgpt'] as const).flatMap((c) => installSteps(c, acme))
    const text = JSON.stringify(steps)
    expect(text).toContain('acmeslicer.mcpb')
    expect(text).toContain('[mcp_servers.acmeslicer]')
    expect(text).toContain('name=acmeslicer')
    expect(text.replace(/SLICERX_MCP_\w+|slicerx-agent-[\w-]+|SlicerX\.app/g, '')).not.toMatch(/slicerx/i)
  })

  it('lists the five clients and marks ChatGPT as waiting for the relay', () => {
    expect(AGENT_CLIENTS.map((c) => c.id)).toEqual(['claude-desktop', 'claude-code', 'cursor', 'codex', 'chatgpt'])
    expect(AGENT_CLIENTS.filter((c) => c.needsRelay).map((c) => c.id)).toEqual(['chatgpt'])
    expect(installSteps('chatgpt', input)[0]?.kind).toBe('waits')
  })

  it('gives Cursor a deep link whose config pins the hub and names the keychain item', () => {
    const [link] = installSteps('cursor', input)
    if (link?.kind !== 'deeplink') throw new Error('expected a deep link')
    const url = new URL(link.url)
    expect(url.protocol).toBe('cursor:')
    const config = JSON.parse(Buffer.from(url.searchParams.get('config') ?? '', 'base64').toString('utf8'))
    expect(config.command).toBe('node')
    expect(config.env).toEqual({ SLICERX_MCP_PRINTERS: 'link', SLICERX_MCP_LINK_URL: 'ws://127.0.0.1:47615', SLICERX_MCP_LINK_HUB_KEY: 'HUBKEYBASE64=', SLICERX_MCP_LINK_KEY_REF: 'slicerx-agent-cursor' })
  })

  it('gives Claude Code and Codex one command each, runnable as argv or copyable', () => {
    const [cc] = installSteps('claude-code', input)
    const [cx] = installSteps('codex', input)
    if (cc?.kind !== 'command' || cx?.kind !== 'command') throw new Error('expected commands')
    expect(cc.argv.slice(0, 4)).toEqual(['claude', 'mcp', 'add-json', 'slicerx'])
    expect(JSON.parse(cc.argv[4] ?? '{}').type).toBe('stdio')
    expect(cc.text).toContain("'{")
    expect(cx.argv).toContain('--')
    expect(cx.argv).toContain('SLICERX_MCP_LINK_KEY_REF=slicerx-agent-codex')
    const toml = installSteps('codex', input)[1]
    expect(toml?.kind === 'config' && toml.snippet).toContain('[mcp_servers.slicerx.env]')
  })

  it('packs Claude Desktop as an extension bundle', () => {
    const [b] = installSteps('claude-desktop', input)
    if (b?.kind !== 'bundle') throw new Error('expected a bundle')
    expect(b.fileName).toBe('slicerx.mcpb')
    expect((b.manifest['server'] as { mcp_config: { env: Record<string, string> } }).mcp_config.env['SLICERX_MCP_LINK_KEY_REF']).toBe('slicerx-agent-claude-desktop')
  })

  it('never puts a secret in any config', () => {
    for (const c of AGENT_CLIENTS) {
      const all = JSON.stringify(installSteps(c.id, input))
      expect(all).not.toMatch(/AGNT|clientKey|link_code|LINK_CODE/)
    }
  })

  it('reads a credential only from a SlicerX agent item, and says how to fix a missing one', () => {
    expect(agentKeyRef('cursor')).toBe('slicerx-agent-cursor')
    expect(() => readKeychainKey('login-password', () => 'x')).toThrow(/not a SlicerX agent credential/)
    if (process.platform === 'darwin') {
      const calls: string[][] = []
      expect(readKeychainKey('slicerx-agent-cursor', (cmd, args) => (calls.push([cmd, ...args]), 'key-123\n'))).toBe('key-123')
      expect(calls[0]).toEqual(['security', 'find-generic-password', '-s', 'slicerx-agent-cursor', '-a', 'slicerx', '-w'])
      expect(() => readKeychainKey('slicerx-agent-cursor', () => { throw new Error('44') })).toThrow(/Connect this app again/)
    }
    if (process.platform === 'linux') {
      const calls: string[][] = []
      readKeychainKey('slicerx-agent-cursor', (cmd, args) => (calls.push([cmd, ...args]), 'key-123\n'))
      // The keyring crate the desktop app writes with names the account `username` in Secret Service.
      expect(calls[0]).toEqual(['secret-tool', 'lookup', 'service', 'slicerx-agent-cursor', 'username', 'slicerx'])
    }
  })
})
