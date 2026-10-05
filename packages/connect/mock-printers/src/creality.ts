// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Creality stock firmware fake: telemetry over WebSocket, `GET /info`, `POST /upload/<name>`, and
// an MJPEG stream. The wire format follows what Creality Print and the community Home Assistant
// integrations use (OrcaSlicer's CrealityPrint host, ha_creality_ws).
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { JPEG, MockError, type MockMachine } from './machine.ts'
import { listen, readFilePart } from './http-util.ts'
import { acceptWebSocket, frame, readFrames } from './ws-server.ts'

export const MOCK_CREALITY_MODEL = 'CR-K1 Max'
const STATE_CODE: Record<string, number> = { idle: 0, finished: 0, error: 0, offline: 0, preparing: 0, printing: 1, paused: 5 }

const dataRoot = (model: string) => (model.toUpperCase().includes('K1') ? '/usr/data' : '/mnt/UDISK')

function telemetry(m: MockMachine, model: string): Record<string, unknown> {
  const n = m.fx.nozzles[0]
  const active = m.state === 'printing' || m.state === 'paused'
  const t: Record<string, unknown> = {
    model,
    hostname: 'mock-creality',
    nozzleTemp: n?.current ?? 0,
    targetNozzleTemp: n?.target ?? 0,
    bedTemp0: m.fx.bed?.current ?? 0,
    targetBedTemp0: m.fx.bed?.target ?? 0,
    boxTemp: m.fx.chamber?.current ?? 0,
    state: STATE_CODE[m.state] ?? 0,
    err: { errcode: 0 },
    printFileName: active && m.job ? `${dataRoot(model)}/printer_data/gcodes/${m.job.name}` : '',
    printProgress: active && m.job ? Math.round(m.job.progress * 100) : 0,
    layer: active ? m.job?.layer ?? 0 : 0,
    TotalLayer: active ? m.job?.layerCount ?? 0 : 0,
    printLeftTime: active ? m.job?.timeLeftS ?? 0 : 0,
  }
  // The printer reports some numbers as strings.
  t.bedTemp0 = String(t.bedTemp0)
  return t
}

export async function startCreality(m: MockMachine, opts: { model?: string; log: string[] }) {
  const model = opts.model ?? MOCK_CREALITY_MODEL
  const sockets = new Set<Socket>()
  const broadcast = () => { const f = frame(JSON.stringify(telemetry(m, model))); for (const s of sockets) s.write(f) }
  let heartbeats = 0

  // WebSocket on its own port (9999 on a printer).
  const wsServer = createServer((_req, res) => res.writeHead(404).end())
  wsServer.on('upgrade', (req: IncomingMessage, sock: Socket) => {
    acceptWebSocket(req, sock, 'wsslicer')
    opts.log.push(`creality subprotocol ${String(req.headers['sec-websocket-protocol'] ?? '')}`)
    sockets.add(sock)
    sock.on('error', () => undefined)
    sock.on('close', () => sockets.delete(sock))
    sock.write(frame(JSON.stringify(telemetry(m, model))))
    const ping = () => sock.write(frame(JSON.stringify({ ModeCode: 'heart_beat' })))
    const first = setTimeout(ping, 200)
    const beat = setInterval(ping, 1000)
    sock.on('close', () => { clearTimeout(first); clearInterval(beat) })
    let rest: Buffer = Buffer.alloc(0)
    sock.on('data', (d: Buffer) => {
      const r = readFrames(Buffer.concat([rest, d]))
      rest = r.rest
      for (const f of r.frames) {
        if (f.op === 8) return void sock.end()
        if (f.op !== 1) continue
        const text = f.data.toString('utf8')
        if (text === 'ok') { if (heartbeats++ === 0) opts.log.push('creality heartbeat answered'); continue }
        const msg = JSON.parse(text) as { method?: string; params?: Record<string, unknown> }
        if (msg.method === 'get') { sock.write(frame(JSON.stringify(telemetry(m, model)))); continue }
        if (msg.method !== 'set') continue
        const p = msg.params ?? {}
        try {
          if (typeof p.opGcodeFile === 'string') {
            const prefix = `printprt:${dataRoot(model)}/printer_data/gcodes/`
            if (!p.opGcodeFile.startsWith(prefix)) throw new MockError(404, 'wrong data root')
            m.start(p.opGcodeFile.slice(prefix.length))
          } else if ('pause' in p) {
            if (Number(p.pause) === 1) m.pause()
            else m.resume()
          } else if ('stop' in p) m.cancel()
          else if (typeof p.gcodeCmd === 'string') m.gcode(p.gcodeCmd)
        } catch {
          // A rejected command leaves the state as it was.
        }
        broadcast()
      }
    })
  })
  await new Promise<void>((r) => wsServer.listen(0, '127.0.0.1', r))

  // REST on its own port (80): /info and /upload/<name>.
  const http = await listen(async (req) => {
    if (req.path === '/info') return { json: { model, hostname: 'mock-creality' } }
    const up = /^\/upload\/(.+)$/.exec(req.path)
    if (up && req.method === 'POST') {
      const f = await readFilePart(req)
      const form = await req.form()
      opts.log.push(`creality upload path=${JSON.stringify(form.get('path') ?? null)} name=${f.name}`)
      m.upload(decodeURIComponent(up[1] ?? ''), f.data)
      return { json: { code: 0 } }
    }
    throw new MockError(404, req.path)
  })

  // MJPEG on its own port (8080).
  const cam = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace;boundary=boundarydonotcross' })
    for (let i = 0; i < 3; i++) res.write(Buffer.concat([Buffer.from('--boundarydonotcross\r\nContent-Type: image/jpeg\r\n\r\n'), JPEG, Buffer.from('\r\n')]))
    res.end()
  })
  await new Promise<void>((r) => cam.listen(0, '127.0.0.1', r))

  return {
    servers: [wsServer, http.server, cam],
    ports: { ws: (wsServer.address() as AddressInfo).port, http: http.port, camera: (cam.address() as AddressInfo).port },
  }
}
