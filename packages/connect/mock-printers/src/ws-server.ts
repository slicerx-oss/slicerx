// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A minimal WebSocket server side (RFC 6455): handshake, text frames out, masked frames in.
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Completes the upgrade. Echoes the first offered subprotocol when `protocol` is given and offered. */
export function acceptWebSocket(req: IncomingMessage, sock: Socket, protocol?: string): void {
  const key = String(req.headers['sec-websocket-key'] ?? '')
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim())
  const echo = protocol && offered.includes(protocol) ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${echo}\r\n`)
}

export function frame(text: string): Buffer {
  const body = Buffer.from(text)
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255]) : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(4), Buffer.from([(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255])])
  return Buffer.concat([head, body])
}

/** Reads client (masked) frames and calls back with text payloads. */
export function readFrames(buf: Buffer): { frames: { op: number; data: Buffer }[]; rest: Buffer } {
  const frames: { op: number; data: Buffer }[] = []
  for (;;) {
    if (buf.length < 2) break
    const op = (buf[0] ?? 0) & 0x0f
    let len = (buf[1] ?? 0) & 0x7f
    let o = 2
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); o = 4 } else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); o = 10 }
    const masked = ((buf[1] ?? 0) & 0x80) !== 0
    const need = o + (masked ? 4 : 0) + len
    if (buf.length < need) break
    const mask = masked ? buf.subarray(o, o + 4) : undefined
    const data = Buffer.from(buf.subarray(o + (masked ? 4 : 0), need))
    if (mask) for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) ^ (mask[i % 4] ?? 0)
    frames.push({ op, data })
    buf = buf.subarray(need)
  }
  return { frames, rest: buf }
}

