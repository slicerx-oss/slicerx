// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The connected apps the hub has, in the app state, so the printer setup offers a connection that goes
// through an app only once it is added. Read from the hub when the bridge connects and after each change.
import { useEffect } from 'react'
import { liveBridge } from '../link/bridge'
import { set, useApp, type AppState } from '../state/store'

/** Reads the hub's connected apps into the state. With no bridge there are none. */
export async function refreshConnectedApps(): Promise<AppState['connectedApps']> {
  const services = liveBridge()?.services
  if (!services) {
    set({ connectedApps: [] })
    return []
  }
  try {
    const apps = (await services.list()).map((s) => ({ id: s.pluginId, baseUrl: s.baseUrl, hasSecret: s.hasSecret }))
    set({ connectedApps: apps })
    return apps
  } catch {
    // An older hub, or one that went away: keep what was read last.
    return []
  }
}

/** The connected apps, read again whenever the bridge connects or its printers change. */
export function useConnectedApps(): AppState['connectedApps'] {
  const epoch = useApp((s) => s.linkEpoch)
  const bridge = useApp((s) => s.bridgeStatus.state)
  useEffect(() => {
    void refreshConnectedApps()
  }, [epoch, bridge])
  return useApp((s) => s.connectedApps)
}
