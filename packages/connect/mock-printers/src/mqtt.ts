// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The slice of MQTT 3.1.1 a Bambu Lab printer's broker needs: CONNECT, SUBSCRIBE, PUBLISH
// (QoS 0 and 1), PINGREQ. https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html

export interface Packet { type: number; flags: number; body: Buffer }

/** Splits a byte stream into MQTT packets. */
export class PacketReader {
  private buf = Buffer.alloc(0)
  push(chunk: Buffer): Packet[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: Packet[] = []
    for (;;) {
      if (this.buf.length < 2) break
      let mult = 1
      let len = 0
      let i = 1
      let done = false
      while (i < this.buf.length && i <= 4) {
        const b = this.buf[i] ?? 0
        len += (b & 0x7f) * mult
        mult *= 128
        i++
        if ((b & 0x80) === 0) { done = true; break }
      }
      if (!done || this.buf.length < i + len) break
      const first = this.buf[0] ?? 0
      out.push({ type: first >> 4, flags: first & 0x0f, body: this.buf.subarray(i, i + len) })
      this.buf = this.buf.subarray(i + len)
    }
    return out
  }
}

function varint(n: number): Buffer {
  const bytes: number[] = []
  do {
    let b = n % 128
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    bytes.push(b)
  } while (n > 0)
  return Buffer.from(bytes)
}

export function encode(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), varint(body.length), body])
}

export function parseConnect(body: Buffer): { user: string; pass: string; clientId: string } {
  let o = 0
  const str = () => { const n = body.readUInt16BE(o); o += 2; const s = body.toString('utf8', o, o + n); o += n; return s }
  str() // protocol name
  o += 1 // level
  const flags = body.readUInt8(o); o += 1
  o += 2 // keep alive
  const clientId = str()
  if (flags & 0x04) { str(); str() } // will topic and message
  const user = flags & 0x80 ? str() : ''
  const pass = flags & 0x40 ? str() : ''
  return { user, pass, clientId }
}

export function parseSubscribe(body: Buffer): { id: number; topics: string[] } {
  const id = body.readUInt16BE(0)
  const topics: string[] = []
  let o = 2
  while (o < body.length) {
    const n = body.readUInt16BE(o); o += 2
    topics.push(body.toString('utf8', o, o + n)); o += n + 1
  }
  return { id, topics }
}

export function parsePublish(p: Packet): { topic: string; payload: Buffer; qos: number; id?: number } {
  const qos = (p.flags >> 1) & 3
  const n = p.body.readUInt16BE(0)
  const topic = p.body.toString('utf8', 2, 2 + n)
  let o = 2 + n
  let id: number | undefined
  if (qos > 0) { id = p.body.readUInt16BE(o); o += 2 }
  return { topic, payload: p.body.subarray(o), qos, ...(id === undefined ? {} : { id }) }
}

export const connack = (rc: number) => encode(2, 0, Buffer.from([0, rc]))
export const suback = (id: number, n: number) => encode(9, 0, Buffer.concat([Buffer.from([id >> 8, id & 0xff]), Buffer.alloc(n)]))
export const puback = (id: number) => encode(4, 0, Buffer.from([id >> 8, id & 0xff]))
export const pingresp = () => encode(13, 0, Buffer.alloc(0))
export function publish(topic: string, payload: Buffer): Buffer {
  const t = Buffer.from(topic)
  return encode(3, 0, Buffer.concat([Buffer.from([t.length >> 8, t.length & 0xff]), t, payload]))
}
