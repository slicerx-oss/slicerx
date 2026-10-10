// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Elegoo Centauri Carbon fake: SDCP V3.0.0 over WebSocket plus the chunked HTTP upload.
// https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { MockError, type MockMachine } from './machine.ts'
import { mjpeg, offlineGate } from './http-util.ts'
import { acceptWebSocket, frame, readFrames } from './ws-server.ts'

export const MOCK_MAINBOARD = '000000000001d354'

// Centauri Carbon codes while printing; once idle the sub status keeps its last value (9 complete).
const PRINT_STATUS: Record<string, number> = { idle: 0, finished: 9, error: 0, offline: 0, preparing: 8, printing: 13, paused: 10 }

/** Free storage the attributes report, in bytes. Tests lower it through `extra`. */
export interface ElegooExtra { remainingMemory: number }

function attributesMessage(m: MockMachine, extra: ElegooExtra): string {
  return JSON.stringify({
    Attributes: {
      Name: m.fx.name, MachineName: 'Centauri Carbon', BrandName: 'ELEGOO', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'V1.1.29',
      XYZsize: '256x256x256', MainboardIP: '127.0.0.1', MainboardID: MOCK_MAINBOARD, NetworkStatus: 'wlan', UsbDiskStatus: 0,
      Capabilities: ['FILE_TRANSFER', 'PRINT_CONTROL', 'VIDEO_STREAM'], CameraStatus: m.fx.cameraAvailable ? 1 : 0, RemainingMemory: extra.remainingMemory,
    },
    MainboardID: MOCK_MAINBOARD,
    TimeStamp: Date.now(),
    Topic: `sdcp/attributes/${MOCK_MAINBOARD}`,
  })
}

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

export async function startElegoo(m: MockMachine, extra: ElegooExtra = { remainingMemory: 8_000_000_000 }) {
  const sockets = new Set<Socket>()
  const uploads = new Map<string, { name: string; chunks: Buffer[]; got: number }>()
  const broadcast = () => { const f = frame(statusMessage(m)); for (const s of sockets) s.write(f) }
  let port = 0

  // Faults. SDCP V3.0.0 has no filament runout code and no door: a runout pauses the print as a pause command
  // does (CurrentStatus 1, PrintInfo.Status 10), with no error code, and a door is only logged. Both stand in
  // until the Centauri Carbon's real reporting is written up; neither code may be made up here.
  m.faultProfile = { door: false }

  // The doc's status reports: one when the status changes (sent after the command's answer), and while printing
  // one a second, so progress and time move on the client.
  let pending = false
  let gate: { dropAll(): void } | undefined
  m.onChange(() => {
    if (m.faults.has('offline')) {
      // Off the network: the WebSocket drops and reconnects are refused until the fault clears.
      gate?.dropAll()
      return
    }
    if (pending) return
    pending = true
    setImmediate(() => { pending = false; broadcast() })
  })
  const tick = setInterval(() => { if (m.state === 'printing') broadcast() }, 1000)
  tick.unref()

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
      if (cmd === 1) {
        respond(sock, cmd, rid, { Ack: 0 })
        return void sock.write(frame(attributesMessage(m, extra)))
      }
      if (cmd === 258) return respond(sock, cmd, rid, { Ack: 0, FileList: [...m.files.values()].map((f) => ({ name: `/local/${f.name}`, usedSize: f.size, totalSize: 0, storageType: 0, type: 1 })) })
      // Each state change below pushes a status report after this answer.
      if (cmd === 128) m.start(String(args.Filename).replace(/^\/local\//, ''))
      else if (cmd === 129) m.pause()
      else if (cmd === 130) m.cancel()
      else if (cmd === 131) m.resume()
      else if (cmd === 386) return respond(sock, cmd, rid, { Ack: 0, VideoUrl: `http://127.0.0.1:${port}/video` })
      else return respond(sock, cmd, rid, { Ack: 1 })
      respond(sock, cmd, rid, { Ack: 0 })
    } catch (e) {
      respond(sock, cmd, rid, { Ack: e instanceof MockError && e.status === 404 ? 2 : 1 })
    }
  }

  const server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    if (url.pathname === '/uploadFile/upload' && req.method === 'POST') {
      const chunks: Buffer[] = []
      try {
        for await (const c of req) chunks.push(c as Buffer)
      } catch {
        return
      }
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
      // The MJPEG stream Cmd 386 names: a frame every 100 ms, the picture `POST /camera` chose, until the client closes.
      const stream = mjpeg(() => m.frame(), 100)
      res.writeHead(200, { 'content-type': stream.type })
      const stop = stream.start((b) => void res.write(b))
      res.on('close', stop)
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
  server.on('close', () => clearInterval(tick))
  gate = offlineGate(server, () => m.faults.has('offline'))
  // A WebSocket is an upgraded connection the HTTP server no longer counts, so closing the server would wait on the
  // clients' sockets forever: close them with it.
  const close = server.close.bind(server)
  server.close = (cb?: (err?: Error) => void) => {
    for (const s of sockets) s.destroy()
    return close(cb)
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  return { server, port }
}
