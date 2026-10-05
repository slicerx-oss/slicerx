// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Transports carry text frames and nothing else. Security never depends on them: the LAN
// socket is plain ws://, and the relay is untrusted. Both only move opaque frames.

/** A two-way channel of text frames to one peer. */
export interface Pipe {
  send(frame: string): void
  onFrame(cb: (frame: string) => void): () => void
  onClose(cb: () => void): () => void
  close(): void
}

/** Minimal WebSocket surface, so browsers, Node, React Native and test fakes all fit. */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error', cb: () => void): void
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void
}

export type SocketFactory = (url: string) => SocketLike

function emitter<T extends unknown[]>() {
  const cbs = new Set<(...a: T) => void>()
  return {
    on(cb: (...a: T) => void): () => void {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
    emit(...a: T): void {
      for (const cb of [...cbs]) cb(...a)
    },
  }
}

/** Opens a WebSocket and resolves once it is open. Rejects on error or after `timeoutMs`. */
export function openSocket(factory: SocketFactory, url: string, timeoutMs = 5000): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    const ws = factory(url)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`Timed out reaching ${url}`))
    }, timeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`Cannot reach ${url}`))
    })
  })
}

export function pipeFromSocket(ws: SocketLike): Pipe {
  const frames = emitter<[string]>()
  const closed = emitter<[]>()
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') frames.emit(ev.data)
  })
  ws.addEventListener('close', () => closed.emit())
  return {
    send: (f) => {
      if (ws.readyState === 1) ws.send(f)
    },
    onFrame: frames.on,
    onClose: closed.on,
    close: () => ws.close(),
  }
}

/** Two connected in-memory pipes. Delivery is asynchronous, as on a real socket. */
export function memoryPipePair(): [Pipe, Pipe] {
  const make = () => ({ frames: emitter<[string]>(), closed: emitter<[]>(), open: true })
  const a = make()
  const b = make()
  const side = (me: typeof a, other: typeof a): Pipe => ({
    send: (f) => {
      if (me.open && other.open) queueMicrotask(() => other.frames.emit(f))
    },
    onFrame: me.frames.on,
    onClose: me.closed.on,
    close: () => {
      if (!me.open) return
      me.open = false
      other.open = false
      queueMicrotask(() => {
        me.closed.emit()
        other.closed.emit()
      })
    },
  })
  return [side(a, b), side(b, a)]
}

// ---------------------------------------------------------------------------
// Relay

/**
 * A connection to a relay. Routes are opaque strings: 43 character capabilities for pairings,
 * or `acct:<accountId>:...` routes the relay serves only to that signed-in account.
 */
export interface RelayConnection {
  subscribe(route: string, onBody: (body: string) => void): () => void
  send(route: string, body: string): void
  close(): void
}

/** A pipe over a relay: receives on `mine`, sends to `peer`. */
export function relayPipe(relay: RelayConnection, mine: string, peer: string): Pipe {
  const closed = emitter<[]>()
  const frames = emitter<[string]>()
  let open = true
  const unsub = relay.subscribe(mine, (body) => {
    if (open) frames.emit(body)
  })
  return {
    send: (f) => {
      if (open) relay.send(peer, f)
    },
    onFrame: frames.on,
    onClose: closed.on,
    close: () => {
      if (!open) return
      open = false
      unsub()
      closed.emit()
    },
  }
}

export interface RelayClientOptions {
  url: string
  socket: SocketFactory
  /** Account session token, needed for `acct:` routes only. */
  token?: () => Promise<string | null>
}

/**
 * Relay client over WebSocket. Protocol, one JSON object per text frame:
 * client `{"op":"auth","token"}`, `{"op":"sub","route"}`, `{"op":"unsub","route"}`,
 * `{"op":"send","to","body"}`; relay `{"op":"msg","route","body"}` and
 * `{"op":"error","code","message"}`. See README.md for limits.
 */
export async function connectRelay(opts: RelayClientOptions): Promise<RelayConnection> {
  const ws = await openSocket(opts.socket, opts.url)
  const subs = new Map<string, Set<(body: string) => void>>()
  const token = opts.token ? await opts.token() : null
  if (token) ws.send(JSON.stringify({ op: 'auth', token }))
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string' || ev.data.length > 2_000_000) return
    let msg: unknown
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as Record<string, unknown>
    if (m['op'] === 'msg' && typeof m['route'] === 'string' && typeof m['body'] === 'string') {
      for (const cb of [...(subs.get(m['route']) ?? [])]) cb(m['body'])
    }
  })
  return {
    subscribe(route, onBody) {
      let set = subs.get(route)
      if (!set) {
        set = new Set()
        subs.set(route, set)
        ws.send(JSON.stringify({ op: 'sub', route }))
      }
      set.add(onBody)
      return () => {
        const s = subs.get(route)
        if (!s) return
        s.delete(onBody)
        if (s.size === 0) {
          subs.delete(route)
          if (ws.readyState === 1) ws.send(JSON.stringify({ op: 'unsub', route }))
        }
      }
    },
    send(route, body) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ op: 'send', to: route, body }))
    },
    close: () => ws.close(),
  }
}
