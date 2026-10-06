// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer bridge for the app entries: sx-link over a local WebSocket, through @slicerx/link-client.
// The browser build asks for the pairing code sx-link printed; the desktop build starts its own bridge
// and passes the address and code it got from the shell.
import { connectPinned, shellLinkOptions, type BridgeConnector, type ConnectedBridge } from '@slicerx/app'
import { createPrinterSetup } from '@slicerx/connect'
import { connectLink, linkCameraStreams, type LinkHost } from '@slicerx/link-client'

type Remote = NonNullable<ConnectedBridge['remote']>

function hasRemote(link: LinkHost): link is LinkHost & { remote: Remote } {
  const r = (link as { remote?: Partial<Remote> }).remote
  return typeof r?.status === 'function' && typeof r.configure === 'function' && typeof r.pairings?.put === 'function'
}

/** What the app takes from a connected bridge. */
export function wrapLink(link: LinkHost, relay?: string | null): ConnectedBridge {
  const setup = createPrinterSetup(link)
  return {
    printers: link,
    approvals: link.approvals,
    streams: linkCameraStreams(link),
    setup: {
      discover: (opts) => setup.discover(opts),
      probe: (host, opts) => setup.probe(host, opts),
      testConnection: (c) => setup.testConnection(c),
      addPrinter: (input) => setup.addPrinter(input),
    },
    // The hub's remote access methods ride along when this link client has them.
    // The edition names its relay as an https URL; the hub dials it as a WebSocket.
    ...(hasRemote(link) ? { remote: link.remote, relayUrl: relay ? relay.replace(/^http/, 'ws') : null } : {}),
    // Phone access: the hub's LAN listener, camera and push registrations go to paired phones.
    ...(typeof (link as { watch?: { setHuginn?: unknown } }).watch?.setHuginn === 'function' ? { watch: { huginnPrinters: () => link.watch.huginnPrinters(), setHuginn: (id: string, on: boolean) => link.watch.setHuginn(id, on) } } : {}),
    // Service plugins (Spoolman) set up from Settings.
    ...(typeof (link as { listServices?: unknown }).listServices === 'function' ? { services: { list: () => link.listServices(), configure: (id: 'spoolman' | 'home-assistant', url: string) => link.configureService(id, url), remove: (id: string) => link.removeService(id) } } : {}),
    pair: link.pair,
    camera: link.camera as unknown as NonNullable<ConnectedBridge['camera']>,
    push: link.push,
    secrets: { has: (n) => link.hasSecret(n), set: async (n, v) => void (await link.setSecret(n, v)), delete: (n) => link.deleteSecret(n) },
    ...(link.hubKey ? { hubKey: link.hubKey } : {}),
    close: () => link.close(),
  }
}

/** Browser: the person runs sx-link and types its code. */
export function browserBridge(url?: string, relay?: string | null): BridgeConnector {
  return {
    automatic: false,
    async connect(code) {
      if (!code) throw new Error('Enter the pairing code sx-link printed.')
      // The first pairing pins the hub's key for this address; later connects pass it and refuse a hub that cannot sign.
      return wrapLink(await connectPinned(connectLink, { code, ...(url ? { url } : {}) }), relay)
    },
  }
}

/** Desktop: the shell starts the bridge and says where it listens and which code to use. */
export function shellBridge(start: () => Promise<{ url: string; code: string; hubKey?: string }>, relay?: string | null): BridgeConnector {
  return {
    automatic: true,
    async connect() {
      // The shell started this hub and knows its key, so the client refuses anything else on the port.
      return wrapLink(await connectLink(shellLinkOptions(await start())), relay)
    },
  }
}
