// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which bridge connector the app entry registered. Small on purpose: it loads with the shell, and the connection code
// (bridge.ts) loads the first time the app connects.
import type { ConnectedBridge } from './bridge'
import { set } from '../state/store'

export interface BridgeConnector {
  /** True when the app starts the bridge itself and needs no code (desktop). */
  automatic: boolean
  /** The hub address a browser connects to, when it is not sx-link's default (an end-to-end test build's own port). */
  url?: string
  /** Connects. `code` is the pairing code for a bridge the person started. */
  connect(code?: string): Promise<ConnectedBridge>
  /** True when `connect()` with no code can connect again (a code accepted earlier in this session). */
  canReconnect?(): boolean
}

/** True when a dropped connection can come back without the person: the desktop's own bridge, or a code this session used. */
export function reconnects(c: BridgeConnector | null): boolean {
  return Boolean(c && (c.automatic || c.canReconnect?.()))
}

let connector: BridgeConnector | null = null

export function setBridgeConnector(c: BridgeConnector | null): void {
  connector = c
  set({ bridgeStatus: { state: 'off' } })
}

export const bridgeConnector = (): BridgeConnector | null => connector

/** For tests: forget the connector. */
export function forgetConnector(): void {
  connector = null
}
