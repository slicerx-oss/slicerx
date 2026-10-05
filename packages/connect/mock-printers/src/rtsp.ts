// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An RTSP camera fake: OPTIONS, DESCRIBE, SETUP and PLAY over TCP (or TLS, like the Bambu Lab X1
// and H2 `rtsps` stream), Basic or Digest login, and H.264 RTP interleaved on the connection.
// The NAL units are placeholders: the connector's job is transport and depacketizing, and a real
// decoder sits at the far end.
import { createHash } from 'node:crypto'
import type { AddressInfo, Server, Socket } from 'node:net'
import { createServer as createTcpServer } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'

const md5 = (s: string) => createHash('md5').update(s).digest('hex')
export const REALM = 'sx-camera'
export const NONCE = 'a1b2c3d4e5f6'
// A plausible baseline SPS and PPS, base64 in the SDP.
const SPS = Buffer.from([0x67, 0x42, 0x00, 0x1f, 0x95, 0xa8, 0x14, 0x01, 0x6e, 0x40])
const PPS = Buffer.from([0x68, 0xce, 0x06, 0xe2])

export interface RtspOptions {
  tls?: { key: string; cert: string }
  /** `qop`: a Digest challenge with `qop="auth"`, answered in the RFC 7616 form; without it, the RFC 2069 form live555 uses. */
  login?: { user: string; pass: string; scheme: 'digest' | 'basic'; qop?: boolean }
  /** Frames per second. Every tenth frame is a key frame split over two FU-A packets. */
  fps?: number
  path?: string
  /** False while the camera is switched off: connections are dropped as they arrive. */
  accept?: () => boolean
  /** True: the SDP has no parameter sets, and SPS and PPS go before each key frame as packets of their own with the marker bit set, as some cameras send them. */
  inBand?: () => boolean
  /**
   * One playing session at a time, as live555 on Bambu Lab printers allows: a PLAY from another
   * connection while one plays is dropped. A session ended by TEARDOWN frees the camera at once; one
   * whose connection just went away holds it for `holdMs` more.
   */
  oneSession?: { holdMs: number }
  /** True to drop this PLAY (asked once per PLAY), as live555 sometimes does just after a session ended. */
  dropPlay?: () => boolean
  /** Drops a PLAY that comes less than this many milliseconds after the last session ended, as the H2D does 5 to 10 s after a TEARDOWN. */
  dropWithinMs?: () => number
  /** True for a session that started playing at `startedAt` (ms) and should stop sending frames, its connection left open. */
  stalled?: (startedAt: number) => boolean
  /** Where request lines go besides `log`, prefixed `rtsp `. */
  sharedLog?: string[]
}

export interface RunningRtsp {
  server: Server
  port: number
  /** One line per request: method and whether the login passed. */
  log: string[]
  close(): void
}

/**
 * Digest fields read the way live555's RTSP server reads them (RTSPServer.cpp,
 * parseAuthorizationHeader), which Bambu Lab cameras run: `name="value"` pairs separated by commas.
 * A pair it cannot read, such as a value without quotes, fails the whole header: null.
 */
export function live555Fields(v: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  let rest = v.replace(/^Digest /, '')
  for (;;) {
    const m = /^\s*([^\s=]+)\s*=\s*"([^"]*)"\s*/.exec(rest)
    if (!m) return null
    out[m[1] ?? ''] = m[2] ?? ''
    rest = rest.slice(m[0].length)
    if (!rest.startsWith(',')) return out
    rest = rest.slice(1)
  }
}

/** Digest fields as RFC 7616 allows them: quoted strings or bare tokens. */
function rfcFields(v: string): Record<string, string> {
  return Object.fromEntries([...v.replace(/^Digest /, '').matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)].map((m) => [m[1], m[2] ?? m[3]]))
}

/**
 * Checks a login as a strict server does. Digest: the realm and nonce of this server's challenge,
 * `uri` exactly the request line's URI, and the response over that URI; with `qop` the RFC 7616
 * form with `qop=auth`, `nc` and `cnonce`, without it the RFC 2069 form live555 checks.
 */
function authorized(o: RtspOptions, method: string, uri: string, header: string | undefined): boolean {
  const l = o.login
  if (!l) return true
  if (!header) return false
  if (l.scheme === 'basic') return header === `Basic ${Buffer.from(`${l.user}:${l.pass}`).toString('base64')}`
  if (!header.startsWith('Digest ')) return false
  const kv = l.qop ? rfcFields(header) : live555Fields(header)
  if (!kv) return false
  if (kv.username !== l.user || kv.realm !== REALM || kv.nonce !== NONCE || kv.uri !== uri || !kv.response) return false
  const ha1 = md5(`${l.user}:${REALM}:${l.pass}`)
  const ha2 = md5(`${method}:${uri}`)
  if (!l.qop) return kv.response === md5(`${ha1}:${NONCE}:${ha2}`)
  if (kv.qop !== 'auth' || !kv.nc || !kv.cnonce) return false
  return kv.response === md5(`${ha1}:${NONCE}:${kv.nc}:${kv.cnonce}:auth:${ha2}`)
}

function rtpPacket(seq: number, ts: number, marker: boolean, payload: Buffer): Buffer {
  const h = Buffer.alloc(12)
  h[0] = 0x80
  h[1] = (marker ? 0x80 : 0) | 96
  h.writeUInt16BE(seq & 0xffff, 2)
  h.writeUInt32BE(ts >>> 0, 4)
  h.writeUInt32BE(0x1234, 8)
  const body = Buffer.concat([h, payload])
  const frame = Buffer.alloc(4)
  frame[0] = 0x24
  frame[1] = 0
  frame.writeUInt16BE(body.length, 2)
  return Buffer.concat([frame, body])
}

export async function startRtsp(o: RtspOptions = {}): Promise<RunningRtsp> {
  const path = o.path ?? '/stream'
  const log: string[] = []
  const note = (line: string) => {
    log.push(line)
    o.sharedLog?.push(`rtsp ${line}`)
  }
  const timers = new Set<NodeJS.Timeout>()
  // The playing session, and until when a session whose connection dropped still holds the camera.
  let playing: Socket | null = null
  let heldUntil = 0
  let lastEnded = 0
  const onSocket = (sock: Socket) => {
    sock.on('error', () => undefined)
    if (o.accept && !o.accept()) return void sock.destroy()
    let buf = ''
    let seq = 1
    let n = 0
    let timer: NodeJS.Timeout | undefined
    sock.on('close', () => {
      if (timer) {
        clearInterval(timer)
        timers.delete(timer)
      }
      if (playing === sock) {
        playing = null
        heldUntil = Date.now() + (o.oneSession?.holdMs ?? 0)
        lastEnded = Date.now()
      }
    })
    sock.on('data', (d: Buffer) => {
      buf += d.toString('latin1')
      let i: number
      while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
        const head = buf.slice(0, i)
        buf = buf.slice(i + 4)
        const [reqLine = '', ...lines] = head.split('\r\n')
        const [method = '', uri = ''] = reqLine.split(' ')
        const h = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]))
        const reply = (status: string, extra: string[] = [], body = '') => {
          const lens = body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []
          sock.write([`RTSP/1.0 ${status}`, `CSeq: ${h.cseq ?? '0'}`, ...extra, ...lens, '', body].join('\r\n'))
        }
        const ok = method === 'OPTIONS' || authorized(o, method, uri, h.authorization)
        if (ok && method === 'PLAY' && (o.dropPlay?.() || (lastEnded > 0 && Date.now() - lastEnded < (o.dropWithinMs?.() ?? 0)))) {
          note('PLAY dropped')
          sock.destroy()
          return
        }
        if (ok && method === 'PLAY' && o.oneSession && ((playing && playing !== sock) || Date.now() < heldUntil)) {
          note('PLAY refused: the camera is busy')
          sock.destroy()
          return
        }
        note(`${method} ${ok ? 'ok' : 'denied'}`)
        if (!ok) {
          const ch = o.login?.scheme === 'basic' ? `Basic realm="${REALM}"` : `Digest realm="${REALM}", nonce="${NONCE}"${o.login?.qop ? ', qop="auth"' : ''}`
          reply('401 Unauthorized', [`WWW-Authenticate: ${ch}`])
          continue
        }
        if (method === 'OPTIONS') reply('200 OK', ['Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN'])
        else if (method === 'DESCRIBE') {
          if (!uri.includes(path)) { reply('404 Not Found'); continue }
          const fmtp = o.inBand?.() ? 'a=fmtp:96 packetization-mode=1' : `a=fmtp:96 packetization-mode=1;sprop-parameter-sets=${SPS.toString('base64')},${PPS.toString('base64')}`
          const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=sx', 't=0 0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000', fmtp, 'a=control:track1', ''].join('\r\n')
          reply('200 OK', ['Content-Type: application/sdp', `Content-Base: ${uri}/`], sdp)
        } else if (method === 'SETUP') reply('200 OK', ['Transport: RTP/AVP/TCP;unicast;interleaved=0-1', 'Session: abc123;timeout=60'])
        else if (method === 'PLAY') {
          playing = sock
          reply('200 OK', ['Session: abc123', 'Range: npt=0.000-'])
          const startedAt = Date.now()
          timer = setInterval(() => {
            if (o.stalled?.(startedAt)) return
            const key = n % 10 === 0
            const ts = n * Math.round(90000 / (o.fps ?? 15))
            n++
            if (key && o.inBand?.()) {
              sock.write(rtpPacket(seq++, ts, true, SPS))
              sock.write(rtpPacket(seq++, ts, true, PPS))
            }
            if (key) {
              sock.write(rtpPacket(seq++, ts, false, Buffer.concat([Buffer.from([0x7c, 0x85]), Buffer.alloc(40, 1)])))
              sock.write(rtpPacket(seq++, ts, true, Buffer.concat([Buffer.from([0x7c, 0x45]), Buffer.alloc(40, 2)])))
            } else {
              sock.write(rtpPacket(seq++, ts, true, Buffer.concat([Buffer.from([0x41]), Buffer.alloc(20, 3)])))
            }
          }, Math.round(1000 / (o.fps ?? 15)))
          timers.add(timer)
        } else if (method === 'TEARDOWN') {
          if (timer) {
            clearInterval(timer)
            timers.delete(timer)
            timer = undefined
          }
          if (playing === sock) {
            playing = null
            lastEnded = Date.now()
          }
          reply('200 OK')
        } else reply('200 OK')
      }
    })
  }
  const server = o.tls ? createTlsServer(o.tls, onSocket) : createTcpServer(onSocket)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    server,
    port: (server.address() as AddressInfo).port,
    log,
    close: () => {
      for (const t of timers) clearInterval(t)
      server.close()
    },
  }
}
