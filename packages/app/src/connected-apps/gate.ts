// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which printer connections to offer given the connected apps that are added. Kept apart from the app list
// (registry.ts) so printer setup, which loads with the shell, does not carry the apps' descriptions.
import { connectionMethod, type ConnectionId } from '@slicerx/printer-catalog'

/** The app a connection goes through, if any. */
export function appForConnection(id: ConnectionId): string | undefined {
  return connectionMethod(id).requiresApp
}

/** The connections to offer: one that goes through an app shows only once that app is added. Order is kept. */
export function offeredConnections(choices: readonly ConnectionId[], added: ReadonlySet<string>): ConnectionId[] {
  return choices.filter((id) => {
    const app = appForConnection(id)
    return app === undefined || added.has(app)
  })
}

/** `host:port` of an app's address, for a printer form whose connection goes through that app. */
export function appHostPort(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return ''
  }
}
