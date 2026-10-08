// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connected apps: services on the person's network that SlicerX works with, added once in Settings,
// Connected apps. The hub keeps each one (`services.*`): its address, and the name of its key in the
// secrets store. A printer connection that goes through an app (BamBuddy) is offered only once that app
// is added, so nothing new shows for anyone who never adds one.

export type ConnectedAppId = 'spoolman' | 'bambuddy' | 'home-assistant'

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
  /**
   * Not tested against the real app yet. The hub refuses it unless its experimental connectors are on, so the
   * card shows only then, labeled Experimental.
   */
  experimental?: boolean
  /** What its status line counts: printers, spools, entities. */
  counts: { one: string; many: string }
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
    counts: { one: 'printer', many: 'printers' },
  },
  {
    id: 'spoolman',
    name: 'Spoolman',
    blurb: 'Spoolman keeps track of your spools. Connect it to pick a spool for each filament slot, see the grams left, get a warning when a spool is too short for the plate, and record the filament a print used (you approve each one).',
    defaultPort: 7912,
    https: false,
    addressPlaceholder: 'Address, like 192.168.1.50',
    key: null,
    counts: { one: 'spool', many: 'spools' },
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant',
    blurb: 'See the switches, lights and fans in your Home Assistant, such as a smart plug that powers a printer or an enclosure fan, and turn them on or off. Each change asks for your approval first.',
    defaultPort: 8123,
    https: false,
    addressPlaceholder: 'Address, like 192.168.1.60',
    key: { label: 'Long-lived access token', placeholder: 'From your Home Assistant profile, Security' },
    experimental: true,
    counts: { one: 'switch, light or fan', many: 'switches, lights and fans' },
  },
]

/** What an Experimental label means, for its tooltip. */
export const EXPERIMENTAL_TIP = 'Built from the app\'s documentation but not yet tested against the real app. It may not work, and it can change. It shows only while Try experimental connectors is on (Developer mode).'

/** The apps the Connected apps list shows: an experimental app only while the hub's experimental connectors are on. */
export function visibleApps(experimental: boolean): ConnectedApp[] {
  return CONNECTED_APPS.filter((a) => !a.experimental || experimental)
}

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

export { appForConnection, appHostPort, offeredConnections } from './gate'
