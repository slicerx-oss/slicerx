// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Connect your AI agent" on the desktop: the bundled MCP server's path, the hub this app runs, the
// agent credential in the keychain, and running the client's install step. Tauri commands in
// src-tauri/src/agents.rs; the credential itself never reaches this side.
import { appName, type AgentInstallHost } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'

/** The hub's key and address, for the install steps the Rust side builds itself. */
async function hubInfo(): Promise<{ hubKey: string; linkUrl: string }> {
  const info = await invoke<{ url: string; code: string; hubKey: string }>('link_start')
  return { hubKey: info.hubKey, linkUrl: info.url }
}

export function createTauriAgents(): AgentInstallHost {
  return {
    serverCommand: async () => {
      const path = await invoke<string | null>('mcp_server_path')
      return path ? { command: 'node', args: [path] } : null
    },
    hub: async () => {
      const info = await invoke<{ url: string; code: string; hubKey: string }>('link_start')
      return { hubKey: info.hubKey, linkUrl: info.url }
    },
    // One command does both halves, so the key goes from the hub to the keychain without passing through the webview.
    credential: async (client) => {
      try {
        await invoke<{ clientId: string }>('agent_credential', { client })
        return { ok: true }
      } catch (e) {
        return { ok: false, reason: typeof e === 'string' ? e : e instanceof Error ? e.message : 'The hub did not hand out a credential.' }
      }
    },
    run: async (client, step) => {
      switch (step.kind) {
        case 'deeplink':
          await invoke('open_deeplink', { url: step.url })
          return { ok: true, message: `Opened the install link. Confirm it in the client and ${appName()} is in its tools.` }
        case 'command': {
          // The command is built in Rust from the client name and the hub's key and address; the
          // webview never hands over arguments.
          const out = await invoke<string>('agent_run', { client, ...(await hubInfo()) })
          return { ok: true, message: out.trim() || `Ran ${step.argv[0]}. ${appName()} is in its tools.`, paste: step.text, pasteInto: 'a terminal, to run it again' }
        }
        case 'bundle':
          try {
            await invoke<string>('agent_bundle', await hubInfo())
            return { ok: true, message: `Opened the extension. Confirm it in Claude Desktop and ${appName()} is in its tools.` }
          } catch (e) {
            return { ok: false, message: `${typeof e === 'string' ? e : 'The extension could not be built.'} Add the entry below to claude_desktop_config.json instead.` }
          }
        case 'config':
          return { ok: true, message: `Paste the entry into ${step.path}.`, paste: step.snippet, pasteInto: step.path }
        case 'waits':
          return { ok: false, message: step.reason }
        default:
          return { ok: false, message: 'Unknown install step.' }
      }
    },
    relayReady: async () => false,
    connected: (client) => invoke<boolean>('agent_connected', { client }),
    disconnect: (client) => invoke<void>('agent_disconnect', { client }),
  }
}
