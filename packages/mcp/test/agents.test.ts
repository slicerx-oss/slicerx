// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { AGENT_CLIENTS, agentKeyRef, installSteps, keychainService, serverEnv, SHIPPING_APP_IDENTIFIER, type InstallInput } from '../src/agents'
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
    expect(() => readKeychainKey('login-password', () => 'x')).toThrow(/not an agent credential/)
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
    if (process.platform === 'win32') {
      const calls: string[][] = []
      expect(readKeychainKey('slicerx-agent-cursor', (cmd, args) => (calls.push([cmd, ...args]), 'key-123\n'))).toBe('key-123')
      expect(calls[0]![0]).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/)
      expect(calls[0]).toContain('-NoProfile')
      expect(calls[0]).toContain('-NonInteractive')
      expect(Buffer.from(calls[0]!.at(-1)!, 'base64').toString('utf16le')).toContain("Password('slicerx.slicerx-agent-cursor')")
    }
  })

  it('reads a test build\'s own credential item and never the shipping app\'s', () => {
    const shipping = AGENT_CLIENTS.map((c) => agentKeyRef(c.id))
    // The shipping app, and a config without an identifier, keep exactly today's names.
    expect(shipping).toEqual(['slicerx-agent-claude-desktop', 'slicerx-agent-claude-code', 'slicerx-agent-cursor', 'slicerx-agent-codex', 'slicerx-agent-chatgpt'])
    for (const ref of shipping) {
      expect(keychainService(ref)).toBe(ref)
      expect(keychainService(ref, SHIPPING_APP_IDENTIFIER)).toBe(ref)
    }
    expect(keychainService('slicerx-mimir-cloud-token', 'app.slicerx.desktop')).toBe('slicerx-mimir-cloud-token')
    for (const id of ['app.slicerx.desktop.agent-bridge', 'app.slicerx.desktop.dev', 'app.slicerx.desktop2', 'app.layermate.desktop', 'com.example.demo']) {
      for (const ref of [...shipping, 'slicerx-printers', 'slicerx-pair', 'slicerx-mimir-cloud-token', 'slicerx-chatgpt']) {
        const name = keychainService(ref, id)
        expect(shipping).not.toContain(name)
        expect(name).toBe(`${ref}.${id}`)
      }
    }
    // The config a test build writes names the item as always, plus the app; the shipping app's config is unchanged.
    expect(serverEnv('cursor', { ...input, appIdentifier: 'app.slicerx.desktop.agent-bridge' })).toMatchObject({ SLICERX_MCP_LINK_KEY_REF: 'slicerx-agent-cursor', SLICERX_MCP_APP_IDENTIFIER: 'app.slicerx.desktop.agent-bridge' })
    expect(serverEnv('cursor', { ...input, appIdentifier: SHIPPING_APP_IDENTIFIER })).toEqual(serverEnv('cursor', input))
    expect(serverEnv('cursor', input)).not.toHaveProperty('SLICERX_MCP_APP_IDENTIFIER')
    // The server asks the store for <ref>.<identifier>.
    const calls: string[][] = []
    const run = (cmd: string, args: string[]) => (calls.push([cmd, ...args]), 'key-123\n')
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(readKeychainKey('slicerx-agent-cursor', run, 'app.slicerx.desktop.agent-bridge')).toBe('key-123')
      readKeychainKey('slicerx-agent-cursor', run, SHIPPING_APP_IDENTIFIER)
      expect(calls.map((c) => c.find((a) => a.startsWith('slicerx-agent-')))).toEqual(['slicerx-agent-cursor.app.slicerx.desktop.agent-bridge', 'slicerx-agent-cursor'])
    }
    if (process.platform === 'win32') {
      expect(readKeychainKey('slicerx-agent-cursor', run, 'app.slicerx.desktop.agent-bridge')).toBe('key-123')
      readKeychainKey('slicerx-agent-cursor', run, SHIPPING_APP_IDENTIFIER)
      expect(calls.map((c) => Buffer.from(c.at(-1)!, 'base64').toString('utf16le').match(/Password\('([^']+)'\)/)?.[1])).toEqual(['slicerx.slicerx-agent-cursor.app.slicerx.desktop.agent-bridge', 'slicerx.slicerx-agent-cursor'])
    }
    expect(() => readKeychainKey('slicerx-agent-cursor', run, 'bad id; rm')).toThrow(/not an app identifier/)
  })
})
