// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Elegoo Centauri Carbon fake: SDCP V3.0.0 over WebSocket plus the chunked HTTP upload.
// https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { JPEG, MockError, type MockMachine } from './machine.ts'
import { acceptWebSocket, frame, readFrames } from './ws-server.ts'

export const MOCK_MAINBOARD = '000000000001d354'

const PRINT_STATUS: Record<string, number> = { idle: 0, finished: 0, error: 0, offline: 0, preparing: 8, printing: 13, paused: 10 }

function statusMessage(m: MockMachine): string {
  const n = m.fx.nozzles[0]
  const active = m.state === 'printing' || m.state === 'paused' || m.state === 'preparing'
  return JSON.stringify({
    Status: {
      CurrentStatus: [active ? 1 : 0],
      TempOfNozzle: n?.current, TempTargetNozzle: n?.target,
      TempOfHotbed: m.fx.bed?.current, TempTargetHotbed: m.fx.bed?.target,
      TempOfBox: m.fx.chamber?.current, TempTargetBox: 0,
      PrintInfo: {
        Status: PRINT_STATUS[m.state] ?? 0,
        CurrentLayer: active ? m.job?.layer ?? 0 : 0,
        TotalLayer: active ? m.job?.layerCount ?? 0 : 0,
        CurrentTicks: m.job ? Math.round(m.job.progress * 3600) : 0,
        TotalTicks: m.job ? 3600 : 0,
        Filename: active && m.job ? `/local/${m.job.name}` : '',
        Progress: m.job ? Math.round(m.job.progress * 100) : 0,
      },
    },
    MainboardID: MOCK_MAINBOARD,
    TimeStamp: Date.now(),
    Topic: `sdcp/status/${MOCK_MAINBOARD}`,
  })
}

export async function startElegoo(m: MockMachine) {
  const sockets = new Set<Socket>()
  const uploads = new Map<string, { name: string; chunks: Buffer[]; got: number }>()
  const broadcast = () => { const f = frame(statusMessage(m)); for (const s of sockets) s.write(f) }
  let port = 0

  const respond = (sock: Socket, cmd: number, rid: string, data: Record<string, unknown>) => {
    sock.write(frame(JSON.stringify({ Id: '', Data: { Cmd: cmd, Data: data, RequestID: rid, MainboardID: MOCK_MAINBOARD, TimeStamp: Date.now() }, Topic: `sdcp/response/${MOCK_MAINBOARD}` })))
  }

  const handleCommand = (sock: Socket, text: string) => {
    if (text === 'ping') return void sock.write(frame('pong'))
    const msg = JSON.parse(text) as { Data?: { Cmd?: number; Data?: Record<string, unknown>; RequestID?: string } }
    const cmd = msg.Data?.Cmd ?? -1
    const rid = msg.Data?.RequestID ?? ''
    const args = msg.Data?.Data ?? {}
    try {
      if (cmd === 0) return void sock.write(frame(statusMessage(m)))
      if (cmd === 128) m.start(String(args.Filename).replace(/^\/local\//, ''))
      else if (cmd === 129) m.pause()
      else if (cmd === 130) m.cancel()
      else if (cmd === 131) m.resume()
      else if (cmd === 386) return respond(sock, cmd, rid, { Ack: 0, VideoUrl: `http://127.0.0.1:${port}/video` })
      else return respond(sock, cmd, rid, { Ack: 1 })
      respond(sock, cmd, rid, { Ack: 0 })
      broadcast()
    } catch (e) {
      respond(sock, cmd, rid, { Ack: e instanceof MockError && e.status === 404 ? 2 : 1 })
    }
  }

  const server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    if (url.pathname === '/uploadFile/upload' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type'] ?? '') } }).formData()
      const file = form.get('File')
      const uuid = String(form.get('Uuid'))
      const total = Number(form.get('TotalSize'))
      if (!(file instanceof File)) { res.writeHead(400).end(); return }
      const u = uploads.get(uuid) ?? { name: file.name, chunks: [], got: 0 }
      if (Number(form.get('Offset')) !== u.got) { res.writeHead(400).end(JSON.stringify({ success: false })); return }
      u.chunks.push(Buffer.from(await file.arrayBuffer()))
      u.got += file.size
      uploads.set(uuid, u)
      if (u.got >= total) {
        const all = Buffer.concat(u.chunks)
        const md5 = createHash('md5').update(all).digest('hex')
        if (md5 !== String(form.get('S-File-MD5'))) { res.writeHead(400).end(JSON.stringify({ success: false, code: 'md5' })); return }
        m.upload(u.name, all)
        uploads.delete(uuid)
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: '000000', messages: null, data: {}, success: true }))
      return
    }
    if (url.pathname === '/video') {
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
      for (let i = 0; i < 3; i++) res.write(Buffer.concat([Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'), JPEG, Buffer.from('\r\n')]))
      res.end()
      return
    }
    res.writeHead(404).end()
  })

  server.on('upgrade', (req: IncomingMessage, sock: Socket) => {
    if (req.url !== '/websocket') return void sock.destroy()
    acceptWebSocket(req, sock)
    sockets.add(sock)
    let rest: Buffer = Buffer.alloc(0)
    sock.on('error', () => undefined)
    sock.on('close', () => sockets.delete(sock))
    sock.on('data', (d: Buffer) => {
      const r = readFrames(Buffer.concat([rest, d]))
      rest = r.rest
      for (const f of r.frames) {
        if (f.op === 8) return void sock.end()
        if (f.op === 1) handleCommand(sock, f.data.toString('utf8'))
      }
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  return { server, port }
}
