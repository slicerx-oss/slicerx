// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Anycubic LAN Mode fake: GET /info and the signed POST to ctrlInfoUrl that hands out AES-128-CBC
// encrypted broker credentials and a client certificate, then the printer's MQTT broker on TLS, which
// asks for that certificate. Written from community projects (anycubic_ha_local, kobra-connect,
// kobra-lan-monitor); no Anycubic document describes it.
import { createCipheriv, createHash, randomBytes, X509Certificate } from 'node:crypto'
import type { AddressInfo, Server } from 'node:net'
import { createServer as createTlsServer, type TLSSocket } from 'node:tls'
import type { MockMachine } from './machine.ts'
import { listen, type Handler } from './http-util.ts'
import { connack, PacketReader, parseConnect, parsePublish, parseSubscribe, pingresp, puback, publish, suback } from './mqtt.ts'
import { throwawayCert } from './tls.ts'

export const MOCK_ANYCUBIC_MODEL = '20024'
const PREFIX = 'anycubic/anycubicCloud/v1'
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

/** `cloud: true` makes /info say LAN Mode is off. `rotate()` changes the broker login, as a printer restart does. */
export interface AnycubicExtra { cloud: boolean; rotate(): void }

export async function startAnycubic(m: MockMachine, log: string[]) {
  const token = randomBytes(16).toString('hex') // 32 characters: sign key in the first half, AES key in the second
  const deviceId = randomBytes(16).toString('hex')
  const device = throwawayCert('anycubic-device')
  const broker = throwawayCert('anycubic-broker')
  const deviceFingerprint = new X509Certificate(device.cert).fingerprint256
  const subscribers = new Set<TLSSocket>()
  let login = { user: `u${randomBytes(4).toString('hex')}`, pass: randomBytes(12).toString('hex') }
  const extra: AnycubicExtra = {
    cloud: false,
    rotate: () => {
      login = { user: `u${randomBytes(4).toString('hex')}`, pass: randomBytes(12).toString('hex') }
      for (const s of subscribers) s.destroy()
    },
  }

  const report = (type: string, data: unknown) => publish(`${PREFIX}/printer/public/${MOCK_ANYCUBIC_MODEL}/${deviceId}/${type}/report`, Buffer.from(JSON.stringify({ type, action: 'report', timestamp: Date.now(), msgid: randomBytes(8).toString('hex'), state: 'done', code: 200, data })))
  const infoData = () => {
    const n = m.fx.nozzles[0]
    const busy = m.state === 'printing' || m.state === 'paused' || m.state === 'preparing'
    // A print set through the control server has no job of its own; the printer still names one.
    const job = m.job ?? { name: 'cube.gcode', progress: 0.4, layer: 12, layerCount: 100, timeLeftS: 1800 }
    return {
      printerName: m.fx.name, model: 'Anycubic Kobra 3', version: '2.3.5.3', ip: '127.0.0.1', state: busy ? 'busy' : 'free',
      temp: { curr_nozzle_temp: n?.current ?? 25, target_nozzle_temp: n?.target ?? 0, curr_hotbed_temp: m.fx.bed?.current ?? 24, target_hotbed_temp: m.fx.bed?.target ?? 0 },
      ...(busy ? { project: { state: 'printing', pause: m.state === 'paused' ? 1 : 0, progress: Math.round(job.progress * 100), curr_layer: job.layer, total_layers: job.layerCount, remain_time: Math.round(job.timeLeftS / 60), filename: `/useremain/app/gk/gcodes/${job.name}` } } : {}),
    }
  }
  const ace = () => ({ multi_color_box: [{ id: 0, status: 1, slots: [{ index: 0, type: 'PLA', color: [255, 0, 16], consumables_percent: 80, status: 5 }, { index: 1, type: 'PETG', color: [0, 0, 0], status: 4 }] }] })
  const pushAll = () => { for (const s of subscribers) s.write(report('info', infoData())) }

  const mqtt: Server = createTlsServer({ key: broker.key, cert: broker.cert, requestCert: true, rejectUnauthorized: false }, (sock: TLSSocket) => {
    const reader = new PacketReader()
    let authed = false
    sock.on('error', () => undefined)
    sock.on('close', () => subscribers.delete(sock))
    sock.on('data', (chunk: Buffer) => {
      for (const p of reader.push(chunk)) {
        if (p.type === 1) {
          const c = parseConnect(p.body)
          // The client certificate the handshake handed out, and the login of the moment.
          const peer = sock.getPeerX509Certificate()
          authed = c.user === login.user && c.pass === login.pass && peer?.fingerprint256 === deviceFingerprint
          log.push(authed ? 'anycubic mqtt connect' : 'anycubic mqtt refused')
          sock.write(connack(authed ? 0 : 5))
          if (!authed) sock.end()
        } else if (!authed) {
          sock.destroy()
        } else if (p.type === 8) {
          const sub = parseSubscribe(p.body)
          sock.write(suback(sub.id, sub.topics.length))
          if (sub.topics.includes(`${PREFIX}/printer/public/${MOCK_ANYCUBIC_MODEL}/${deviceId}/#`)) subscribers.add(sock)
        } else if (p.type === 3) {
          const pub = parsePublish(p)
          if (pub.id !== undefined) sock.write(puback(pub.id))
          const msg = JSON.parse(pub.payload.toString('utf8')) as { type: string; action: string; data: unknown }
          if (!pub.topic.startsWith(`${PREFIX}/web/printer/${MOCK_ANYCUBIC_MODEL}/${deviceId}/`)) continue
          try {
            if (msg.type === 'info' && msg.action === 'query') sock.write(report('info', infoData()))
            else if (msg.type === 'multiColorBox' && msg.action === 'getInfo') sock.write(report('multiColorBox', ace()))
            else if (msg.type === 'print') {
              if (msg.action === 'pause') m.pause()
              else if (msg.action === 'resume') m.resume()
              else if (msg.action === 'stop') m.cancel()
              log.push(`anycubic print ${msg.action}`)
              sock.write(report('print', null))
              pushAll()
            }
          } catch {
            log.push(`anycubic print ${msg.action} refused`)
          }
        } else if (p.type === 12) {
          sock.write(pingresp())
        }
      }
    })
  })
  await new Promise<void>((r) => mqtt.listen(0, '127.0.0.1', r))
  const mqttPort = (mqtt.address() as AddressInfo).port

  let httpPort = 0
  const handler: Handler = (req) => {
    if (req.path === '/info' && req.method === 'GET') {
      if (extra.cloud) return { json: { ctrlType: 'cloud', modelId: MOCK_ANYCUBIC_MODEL, modelName: 'Anycubic Kobra 3', cn: 'MOCKCN0001' } }
      return { json: { ctrlType: 'lan', token, ctrlInfoUrl: `http://127.0.0.1:${httpPort}/ctrl`, modelId: MOCK_ANYCUBIC_MODEL, modelName: 'Anycubic Kobra 3', cn: 'MOCKCN0001', deviceType: 'fdm', usn: 'uuid:fdm:AA-BB-CC-DD-EE-FF' } }
    }
    if (req.path === '/ctrl' && req.method === 'POST') {
      const ts = req.query.get('ts') ?? ''
      const nonce = req.query.get('nonce') ?? ''
      if (req.query.get('sign') !== md5(md5(token.slice(0, 16)) + ts + nonce)) return { json: { code: 403, message: 'bad sign' } }
      const local = randomBytes(8).toString('hex') // 16 characters, used as the IV
      const plain = JSON.stringify({ broker: `mqtts://127.0.0.1:${mqttPort}`, username: login.user, password: login.pass, deviceId, devicecrt: device.cert, devicepk: device.key })
      const c = createCipheriv('aes-128-cbc', Buffer.from(token.slice(16, 32)), Buffer.from(local))
      const info = Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64')
      log.push('anycubic handshake')
      return { json: { code: 200, message: 'ok', data: { token: local, info } } }
    }
    return { status: 404 }
  }
  const http = await listen(handler)
  httpPort = http.port
  setInterval(pushAll, 500).unref()
  return { http, mqtt, mqttPort, extra }
}
