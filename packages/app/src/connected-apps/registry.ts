// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connected apps: services on the person's network that SlicerX works with, added once in Settings,
// Connected apps. The hub keeps each one (`services.*`): its address, and the name of its key in the
// secrets store. A printer connection that goes through an app (BamBuddy) is offered only once that app
// is added, so nothing new shows for anyone who never adds one.
import { connectionMethod, type ConnectionId } from '@slicerx/printer-catalog'

export type ConnectedAppId = 'spoolman' | 'bambuddy'

export interface ConnectedApp {
  id: ConnectedAppId
  name: string
  /** One line for the list. */
  blurb: string
  /** The app's own default port, used when the address has none. */
  defaultPort: number
  /** Whether the address may be https (BamBuddy can sit behind a proxy). Spoolman serves plain http. */
  https: boolean
  addressPlaceholder: string
  /** What the key is called, when the app needs one. Kept in the secrets store, never in prefs. */
  key: { label: string; placeholder: string } | null
}

export const CONNECTED_APPS: readonly ConnectedApp[] = [
  {
    id: 'bambuddy',
    name: 'BamBuddy',
    blurb: 'Send prints to the printers BamBuddy runs, including ones it reaches through a bridge. Once it is added, those printers can choose BamBuddy as their connection.',
    defaultPort: 8000,
    https: true,
    addressPlaceholder: 'Address, like 192.168.1.50',
    key: { label: 'API key', placeholder: 'From BamBuddy, Settings, API keys' },
  },
  {
    id: 'spoolman',
    name: 'Spoolman',
    blurb: 'Spoolman keeps track of your spools. Connect it to pick a spool for each filament slot, see the grams left, get a warning when a spool is too short for the plate, and record the filament a print used (you approve each one).',
    defaultPort: 7912,
    https: false,
    addressPlaceholder: 'Address, like 192.168.1.50',
    key: null,
  },
]

export const connectedApp = (id: string): ConnectedApp | undefined => CONNECTED_APPS.find((a) => a.id === id)

/** The name the app's key has in the secrets store. */
export const appKeyName = (id: ConnectedAppId): string => `app-${id}`

/**
 * The address as the hub takes it: `scheme://host:port` with no trailing slash. A bare host gets
 * `http://` and the app's own port. https is refused for an app that only serves plain http.
 */
export function appUrl(app: ConnectedApp, input: string): { url: string } | { error: string } {
  let t = input.trim().replace(/\/+$/, '')
  if (!t) return { error: `Type the address of your ${app.name} server.` }
  if (!app.https && /^https:\/\//i.test(t)) return { error: `Use the plain http:// address of ${app.name} on your network.` }
  if (!/^[a-z]+:\/\//i.test(t)) t = `http://${t}`
  if (!/^https?:\/\//i.test(t) || (!app.https && !/^http:\/\//i.test(t))) return { error: app.https ? 'The address must start with http:// or https://.' : 'The address must start with http://.' }
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return { error: `That is not an address, like 192.168.1.50 or ${app.id}.local:${app.defaultPort}.` }
  }
  if (u.pathname !== '/' && u.pathname !== '') return { error: 'Use the server address only, without a path.' }
  return { url: `${u.protocol}//${u.hostname}:${u.port || app.defaultPort}` }
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
