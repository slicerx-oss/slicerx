// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Serves phones on the LAN through a bridge that owns the socket (sx-link's `pair.*` methods, or
// the desktop app's Rust listener). The bridge passes frames through unread; each of its phone
// connections becomes a Pipe for the host.
import type { PairHost } from './host'
import { isLocalUrl } from './offer'
import type { Pipe } from './transport'

/** What sx-link's link-client exposes as `LinkHost.pair`. */
export interface LanBridge {
  listen(enabled: boolean, port?: number): Promise<{ listening: boolean; port?: number; addresses?: string[] }>
  send(conn: string, frame: string): Promise<void>
  close(conn: string): Promise<void>
  onFrame(cb: (conn: string, frame: string) => void): () => void
  onClosed(cb: (conn: string) => void): () => void
}

export interface LanService {
  /** The port phones connect to, for the host's advertised LAN endpoints. */
  port: number | undefined
  /**
   * `ws://` URLs for the machine's private IPv4 addresses, for `host.setEndpoints`. Link-local
   * IPv6 is left out: its zone names the computer's interface, which means nothing on the phone.
   */
  urls: string[]
  stop(): Promise<void>
}

export async function serveLanThroughBridge(host: Pick<PairHost, 'handlePipe'>, bridge: LanBridge, port?: number): Promise<LanService> {
  const pipes = new Map<string, { frames: Set<(f: string) => void>; closers: Set<() => void>; open: boolean }>()

  const pipeFor = (conn: string) => {
    let p = pipes.get(conn)
    if (p) return p
    const entry = { frames: new Set<(f: string) => void>(), closers: new Set<() => void>(), open: true }
    pipes.set(conn, entry)
    const pipe: Pipe = {
      send: (f) => {
        // A failed send means the phone is gone; the bridge reports that as pair.closed.
        if (entry.open) void bridge.send(conn, f).catch(() => undefined)
      },
      onFrame: (cb) => {
        entry.frames.add(cb)
        return () => entry.frames.delete(cb)
      },
      onClose: (cb) => {
        entry.closers.add(cb)
        return () => entry.closers.delete(cb)
      },
      close: () => {
        if (!entry.open) return
        void bridge.close(conn).catch(() => undefined)
        ended(conn)
      },
    }
    host.handlePipe(pipe)
    return entry
  }

  function ended(conn: string): void {
    const p = pipes.get(conn)
    if (!p) return
    pipes.delete(conn)
    p.open = false
    for (const cb of [...p.closers]) cb()
  }

  const offFrame = bridge.onFrame((conn, frame) => {
    for (const cb of [...pipeFor(conn).frames]) cb(frame)
  })
  const offClosed = bridge.onClosed(ended)
  const r = await bridge.listen(true, port)
  const urls =
    r.port === undefined
      ? []
      : (r.addresses ?? [])
          .filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a))
          .map((a) => `ws://${a}:${r.port}/pair`)
          .filter(isLocalUrl)
          .slice(0, 4)
  return {
    port: r.port,
    urls,
    async stop() {
      offFrame()
      offClosed()
      for (const conn of [...pipes.keys()]) ended(conn)
      await bridge.listen(false).catch(() => undefined)
    },
  }
}
