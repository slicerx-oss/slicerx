// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connects the page side of the agent bridge (packages/app/src/agent-bridge) to the shell's endpoint
// (src-tauri/src/agent_bridge). Imported only by a build made with SLICERX_AGENT_BRIDGE=1; it does nothing unless the
// shell was built with the agent-bridge feature and started with SX_AGENT_BRIDGE_PORT. See docs/agent-bridge.md.
import type { EditionHost } from '@slicerx/contracts'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { BridgeError, createPageBridge, installCapture } from '../../../packages/app/src/agent-bridge'

interface Call {
  id: number
  tool: string
  args: Record<string, unknown>
}

/** Starts recording and answering when the shell's bridge runs; returns how to hand over the host, or null. */
export async function startAgentBridge(): Promise<((host: EditionHost) => void) | null> {
  // Recording starts first, before the app makes its backend clients, so their calls are seen; it stops if the bridge is off.
  const capture = installCapture(window)
  const bridge = createPageBridge(capture)
  let stop: (() => void) | null = null
  try {
    stop = await listen<Call>('sx-agent-bridge', ({ payload }) => {
      const { id, tool, args } = payload
      bridge.handle(tool, args).then(
        (value) => invoke('agent_bridge_reply', { id, ok: true, value: value ?? null }),
        (e: unknown) =>
          invoke('agent_bridge_reply', {
            id,
            ok: false,
            value: e instanceof Error ? e.message : String(e),
            code: e instanceof BridgeError ? e.code : 'page_error',
          }),
      )
    })
    if (await invoke<boolean>('agent_bridge_ready', { app: false })) {
      return (host) => {
        bridge.attach(host)
        // Health reports appReady from here on: the app has its host and renders next.
        void invoke('agent_bridge_ready', { app: true })
      }
    }
  } catch {
    // A shell without the bridge has no such command.
  }
  stop?.()
  capture.stop()
  return null
}
