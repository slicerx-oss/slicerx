// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bambu Lab LAN fake: MQTT over TLS, implicit FTPS, the port 6000 camera stream and SSDP search answers.
// https://github.com/Doridian/OpenBambuAPI (mqtt.md, ftp.md, video.md)
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { readFileSync } from 'node:fs'
import { createServer as createTlsServer, type TLSSocket } from 'node:tls'
import { fileURLToPath } from 'node:url'
import type { AddressInfo, Server, Socket } from 'node:net'
import type { MockMachine } from './machine.ts'
import { connack, pingresp, PacketReader, parseConnect, parsePublish, parseSubscribe, publish, puback, suback } from './mqtt.ts'
import { startRtsp, type RunningRtsp } from './rtsp.ts'
import { throwawayCert } from './tls.ts'

export const MOCK_ACCESS_CODE = '12345678'
export const MOCK_SERIAL = '01S00C000000000'

const GCODE_STATE: Record<string, string> = { idle: 'IDLE', printing: 'RUNNING', paused: 'PAUSE', finished: 'FINISH', error: 'FAILED', preparing: 'PREPARE', offline: 'IDLE' }

/** What the Bambu fake keeps beyond the shared machine: skipped object ids and the last error. */
export interface BambuExtra {
  skipped: number[]
  printError: number
  lastJob?: string
  /** When set, the next project starts are refused with this reason (`POST /bambu {refuse}`). */
  refuse?: string
  /** The model code `get_version` and the SSDP answer report (`N2S` A1, `N1` A1 mini, `O1D` H2D; default `BL-P001`, X1 Carbon). An H2D reports the two nozzles, AMS units and external spools of `fixtures/bambu-h2d-pushall.json`. */
  model?: string
  /** `lite`: one AMS lite (the fixture's four slots) beside the external spool; `none`: the external spool only. Default: one AMS. */
  ams?: 'ams' | 'lite' | 'none'
  /** What the external spool holds (`vt_tray`); none when absent. */
  external?: { type: string; color: string }
  /** What `ams_filament_setting` wrote per AMS slot (0 based), reported back as the printer does. */
  trays?: Record<number, { info: string; min: number; max: number }>
  /** AMS slots (0 based) holding a spool with a Bambu Lab RFID tag, reported with a `tray_uuid`. */
  tagged?: number[]
  /** The chamber light as `ledctrl` last set it (`lights_report`); on when never set. */
  light?: boolean
  /** The speed level `print_speed` last set (`spd_lvl`, 1 to 4); 2, standard, when never set. */
  speedLevel?: number
  /** LAN Only Liveview on the printer's screen: off, an X1 or H2D reports `rtsp_url` `disable` and port 322 is shut. On when never set. */
  liveview?: boolean
  /** The RTSPS stream sends SPS and PPS in band before each key frame, marked as units of their own, and not in the SDP. */
  inBandParameterSets?: boolean
  /** The code the camera takes, when it is not the printer's access code (a camera that refuses the login). */
  cameraCode?: string
  /** The camera's Digest challenge offers `qop="auth"`; without it, it is answered as live555 checks it. */
  digestQop?: boolean
  /** How many of the next PLAY requests the camera drops. */
  dropPlays?: number
  /** The camera drops a PLAY that comes less than this many milliseconds after its last session ended. */
  dropWithinMs?: number
  /** When set (ms since the epoch), the camera sessions playing then stop sending frames and keep their connections open. */
  stalledAt?: number
  /** `print.printer_type` in every report (`C12`, or `3DPrinter-X1` as old X1 firmware sends it); absent when unset. */
  printerType?: string
  /** The storage the report shows (`home_flag` bits 8 and 9 and `sdcard`): `normal` when unset. */
  storage?: 'none' | 'normal' | 'abnormal' | 'readonly'
  /** `fun2` bit 0: the printer prints from its internal storage without an SD card. */
  emmc?: boolean
  /**
   * Developer Mode as the report's `fun` flags give it (bit 0x20000000 set while it is off). Off, the printer keeps
   * sending status but refuses every command and file from a third party, as Bambu Lab's Authorization Control does:
   * a command gets `result: fail` on the report topic and an upload is refused. The real firmware's refusal words are
   * not recorded here; the driver refuses before sending anything when the flag says off. Absent: no `fun` flags.
   */
  developerMode?: boolean
}

/** `fun` values seen on printers: Developer Mode on, and off (signed commands wanted). */
const FUN = { on: '3EC18FFF9CFF', off: '3EC1AFFF9CFF' } as const

const STORAGE = { none: 0, normal: 1, abnormal: 2, readonly: 3 } as const

const PRODUCT: Record<string, string> = { N2S: 'Bambu Lab A1', N1: 'Bambu Lab A1 mini', 'BL-P001': 'Bambu Lab X1 Carbon', O1D: 'Bambu Lab H2D' }

/** X1 and H2 printers serve their camera over RTSPS on 322 and refuse port 6000. Only when the model is set:
 * the default fake keeps port 6000 open and its report silent on the camera route, as older firmware is. */
const rtspModel = (x: BambuExtra) => x.model === 'BL-P001' || x.model === 'O1D'

/** What changed from `was` to `now`, objects compared key by key, as a printer's `msg: 1` report carries it. */
function diff(now: Record<string, unknown>, was: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(now)) {
    const old = was[k]
    if (v && old && typeof v === 'object' && typeof old === 'object' && !Array.isArray(v) && !Array.isArray(old)) {
      const d = diff(v as Record<string, unknown>, old as Record<string, unknown>)
      if (Object.keys(d).length) out[k] = d
    } else if (JSON.stringify(v) !== JSON.stringify(old)) out[k] = v
  }
  return out
}

let h2d: Record<string, unknown> | undefined
/** The H2D hardware part of a report: nozzles, AMS units and external spools. */
function h2dHardware(m: MockMachine): Record<string, unknown> {
  h2d ??= (JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/bambu-h2d-pushall.json', import.meta.url)), 'utf8')) as { print: Record<string, unknown> }).print
  const { device, ams, vir_slot, nozzle_diameter, nozzle_type, fun, sdcard } = h2d
  // The first nozzle follows the machine's nozzle: current in the low 16 bits, target in the high 16.
  const d = structuredClone(device) as { extruder: { info: { temp: number }[] } }
  const n = m.fx.nozzles[0]
  const first = d.extruder.info[0]
  if (n && first) first.temp = (Math.round(n.target) << 16) | Math.round(n.current)
  return { device: d, ams, vir_slot, nozzle_diameter, nozzle_type, fun, sdcard }
}

/** The answer to an SSDP search, laid out as a recorded H2D answer, for the printer at `host`. */
export function ssdpAnswer(x: BambuExtra, host: string): string {
  const code = x.model ?? 'BL-P001'
  return ['HTTP/1.1 200 OK', 'Server: UPnP/1.0', `Location: ${host}`, 'ST: urn:bambulab-com:device:3dprinter:1', 'EXT: ', `USN: ${MOCK_SERIAL}`, 'Cache-Control: max-age=1800', `DevModel.bambu.com: ${code}`, 'DevName.bambu.com: Bay 1', 'DevConnect.bambu.com: lan', 'DevBind.bambu.com: free', 'Devseclink.bambu.com: secure', 'DevVersion.bambu.com: 01.04.00.00', 'DevCap.bambu.com: 1', '', ''].join('\r\n')
}

/** The answer to `get_version`, laid out as the printers send it: the model code is the `project_name` of a module. */
export function versionFor(x: BambuExtra): Record<string, unknown> {
  const code = x.model ?? 'BL-P001'
  return {
    info: {
      command: 'get_version',
      sequence_id: '0',
      module: [
        { name: 'ota', product_name: PRODUCT[code] ?? '', sw_ver: '01.04.00.00', hw_ver: 'OTA', sn: MOCK_SERIAL },
        { name: 'ap', project_name: code, hw_ver: 'AP05', sw_ver: '00.00.29.84', sn: MOCK_SERIAL },
      ],
    },
  }
}

export function reportFor(m: MockMachine, x: BambuExtra = { skipped: [], printError: 0 }): Record<string, unknown> {
  const n = m.fx.nozzles[0]
  const active = m.state !== 'idle' && m.state !== 'offline'
  return {
    print: {
      command: 'push_status',
      sequence_id: '1',
      gcode_state: GCODE_STATE[m.state],
      gcode_start_time: String(m.startedAt),
      // Bits 0 to 2 are the homed axes; bit 7 is the AMS remaining capacity setting, on so slot percents count.
      // Bits 8 and 9 are the SD card: 0 none, 1 normal, 2 abnormal, 3 read only (Bambu Studio `parse_home_flag`).
      home_flag: (m.homed.includes('x') ? 1 : 0) | (m.homed.includes('y') ? 2 : 0) | (m.homed.includes('z') ? 4 : 0) | 0x80 | (STORAGE[x.storage ?? 'normal'] << 8),
      sdcard: (x.storage ?? 'normal') !== 'none',
      ...(x.emmc ? { fun2: '1' } : {}),
      ...(x.printerType ? { printer_type: x.printerType } : {}),
      s_obj: x.skipped,
      mc_percent: m.job ? Math.round(m.job.progress * 100) : 0,
      mc_remaining_time: m.job ? Math.round(m.job.timeLeftS / 60) : 0,
      layer_num: active ? m.job?.layer ?? 0 : 0,
      total_layer_num: active ? m.job?.layerCount ?? 0 : 0,
      subtask_name: active ? m.job?.name ?? '' : x.lastJob ?? '',
      nozzle_temper: n?.current, nozzle_target_temper: n?.target,
      bed_temper: m.fx.bed?.current, bed_target_temper: m.fx.bed?.target,
      chamber_temper: m.fx.chamber?.current,
      print_error: x.printError,
      spd_lvl: x.speedLevel ?? 2,
      cooling_fan_speed: active ? '15' : '0',
      lights_report: [{ node: 'chamber_light', mode: x.light === false ? 'off' : 'on' }],
      ipcam: {
        ipcam_dev: m.fx.cameraAvailable ? '1' : '0',
        ...(rtspModel(x) ? { rtsp_url: x.liveview === false ? 'disable' : 'rtsps://127.0.0.1/streaming/live/1' } : {}),
      },
      ams: {
        ams: m.fx.filamentSystem === 'ams' && x.ams !== 'none'
          ? [{ id: '0', tray: m.fx.slots.slice(0, 4).map((s, i) => ({
              id: String(i), tray_type: s.material ?? '', tray_color: s.color ? `${s.color.replace('#', '').toUpperCase()}FF` : '', remain: s.remainingPct ?? -1,
              ...(x.trays?.[i] ? { tray_info_idx: x.trays[i].info, nozzle_temp_min: String(x.trays[i].min), nozzle_temp_max: String(x.trays[i].max) } : {}),
              ...(x.tagged?.includes(i) ? { tray_uuid: `A1B2C3D4E5F6071829304A5B6C7D8E${String(i).padStart(2, '0')}` } : {}),
            })) }]
          : [],
      },
      ...(x.external ? { vt_tray: { id: '254', tray_type: x.external.type, tray_color: `${x.external.color.replace('#', '').toUpperCase()}FF`, remain: -1 } } : {}),
      ...(x.model === 'O1D' ? h2dHardware(m) : {}),
      ...(x.developerMode === undefined ? {} : { fun: x.developerMode ? FUN.on : FUN.off }),
    },
  }
}

interface Handles { mqtt: Server; ftp: Server; camera: Server; rtsps: RunningRtsp; ssdp: UdpSocket }

export async function startBambu(m: MockMachine, log: string[]): Promise<{ handles: Handles; ports: { mqtt: number; ftp: number; camera: number; rtsps: number; ssdp: number }; serial: string; accessCode: string; extra: BambuExtra }> {
  const tls = throwawayCert(MOCK_SERIAL)
  const listen = async (srv: Server) => { await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); return (srv.address() as AddressInfo).port }

  // MQTT broker.
  const subscribers = new Set<Socket>()
  // Connections by MQTT client id: a second CONNECT with the same id closes the first (MQTT 3.1.1, 3.1.4-2).
  const clients = new Map<string, Socket>()
  const extra: BambuExtra = { skipped: [], printError: 0 }
  const send = (sock: Socket, report: Record<string, unknown>) => sock.write(publish(`device/${MOCK_SERIAL}/report`, Buffer.from(JSON.stringify(report))))
  const mqtt = createTlsServer(tls, (sock: TLSSocket) => {
    const reader = new PacketReader()
    let authed = false
    let id = ''
    sock.on('error', () => undefined)
    sock.on('close', () => {
      subscribers.delete(sock)
      if (clients.get(id) === sock) clients.delete(id)
    })
    sock.on('data', (chunk: Buffer) => {
      for (const p of reader.push(chunk)) {
        if (p.type === 1) {
          const c = parseConnect(p.body)
          authed = c.user === 'bblp' && c.pass === MOCK_ACCESS_CODE
          if (authed) {
            id = c.clientId
            log.push('mqtt connect')
            const old = clients.get(id)
            if (old && old !== sock) {
              log.push(`mqtt takeover ${id}`)
              old.destroy()
            }
            clients.set(id, sock)
          }
          sock.write(connack(authed ? 0 : 4))
          if (!authed) sock.end()
        } else if (!authed) {
          sock.destroy()
        } else if (p.type === 8) {
          const s = parseSubscribe(p.body)
          sock.write(suback(s.id, s.topics.length))
          if (s.topics.includes(`device/${MOCK_SERIAL}/report`)) subscribers.add(sock)
        } else if (p.type === 3) {
          const pub = parsePublish(p)
          if (pub.id !== undefined) sock.write(puback(pub.id))
          if (pub.topic !== `device/${MOCK_SERIAL}/request`) continue
          handleRequest(JSON.parse(pub.payload.toString('utf8')) as Record<string, Record<string, unknown>>)
        } else if (p.type === 12) {
          sock.write(pingresp())
        }
      }
    })
  })
  // What the last report said, for the H2D's change-only reports.
  let sent: Record<string, unknown> = {}
  const broadcast = (full = false) => {
    const now = reportFor(m, extra) as { print: Record<string, unknown> }
    if (extra.model !== 'O1D' || full) {
      sent = now.print
      for (const s of subscribers) send(s, extra.model === 'O1D' ? { print: { ...now.print, msg: 0 } } : now)
      return
    }
    // An H2D answers pushall in full (`msg` 0) and otherwise sends only what changed (`msg` 1), objects
    // included part by part: a recorded report carried `ipcam` with `ipcam_record` alone.
    const changed = diff(now.print, sent)
    const d = { ...changed, command: 'push_status', sequence_id: now.print.sequence_id, msg: 1, ipcam: { ...(changed.ipcam as object | undefined), ipcam_record: 'enable' } }
    sent = now.print
    for (const s of subscribers) send(s, { print: d })
  }
  // The real printer pushes a report about once a second; a state changed through the control
  // server reaches the driver the same way.
  setInterval(() => broadcast(), 200).unref()
  const handleRequest = (msg: Record<string, Record<string, unknown>>) => {
    try {
      if (msg.pushing?.command === 'pushall') return broadcast(true)
      if (msg.info?.command === 'get_version') {
        const body = Buffer.from(JSON.stringify(versionFor(extra)))
        for (const s of subscribers) s.write(publish(`device/${MOCK_SERIAL}/report`, body))
        return
      }
      // Developer Mode off: status only. Every command is answered with a refusal and changes nothing.
      if (extra.developerMode === false) {
        const [group, body] = Object.entries(msg)[0] ?? []
        if (!group || !body) return
        log.push(`refused ${String(body.command)}`)
        const answer = Buffer.from(JSON.stringify({ [group]: { command: body.command, sequence_id: body.sequence_id, result: 'fail', reason: 'not authorized' } }))
        for (const s of subscribers) s.write(publish(`device/${MOCK_SERIAL}/report`, answer))
        return
      }
      if (msg.system?.command === 'ledctrl') {
        log.push(`ledctrl ${String(msg.system.led_node)} ${String(msg.system.led_mode)}`)
        if (msg.system.led_node === 'chamber_light') extra.light = msg.system.led_mode !== 'off'
        return broadcast()
      }
      const pr = msg.print
      if (!pr) return
      switch (pr.command) {
        case 'print_speed': log.push(`print_speed ${String(pr.param)}`); extra.speedLevel = Number(pr.param); break
        case 'pause': m.pause(); break
        case 'resume': m.resume(); break
        // The printer keeps 0300_400C (task canceled) in the report until the next start.
        case 'stop': if (m.job) extra.lastJob = m.job.name; m.cancel(); extra.printError = 0x0300400c; break
        case 'skip_objects': {
          if (m.state !== 'printing' && m.state !== 'paused') return
          const ids = (pr.obj_list as unknown[]).map(Number)
          extra.skipped.push(...ids.filter((i) => !extra.skipped.includes(i)))
          log.push(`skip_objects ${JSON.stringify(ids)}`)
          break
        }
        case 'gcode_line': m.gcode(String(pr.param).trim()); break
        case 'project_file': {
          // The printer answers every project start on the report topic with `result` and `reason`.
          const answer = (result: string, reason: string) => {
            const body = Buffer.from(JSON.stringify({ print: { command: 'project_file', sequence_id: pr.sequence_id, param: pr.param, result, reason } }))
            for (const s of subscribers) s.write(publish(`device/${MOCK_SERIAL}/report`, body))
          }
          if (extra.refuse) {
            log.push(`project_file refused ${extra.refuse}`)
            answer('fail', extra.refuse)
            return
          }
          answer('success', 'success')
          log.push(`project_file ${JSON.stringify({ param: pr.param, url: pr.url, ams_mapping: pr.ams_mapping, ams_mapping2: pr.ams_mapping2, use_ams: pr.use_ams, bed_levelling: pr.bed_levelling, flow_cali: pr.flow_cali, vibration_cali: pr.vibration_cali, layer_inspect: pr.layer_inspect, timelapse: pr.timelapse })}`)
          m.start(String(pr.url).replace(/^ftp:\/\/\//, '').replace(/^file:\/\/\/sdcard\//, '').replace(/^cache\//, ''))
          extra.skipped = []
          extra.printError = 0
          break
        }
        case 'ams_filament_setting': {
          // The printer takes the slot's preset id, type, color and nozzle range, and answers on the report topic.
          const slot = Number(pr.slot_id)
          const fx = Number(pr.ams_id) === 0 ? m.fx.slots[slot] : undefined
          const answer = { ...pr, result: fx ? 'success' : 'fail', reason: fx ? '' : 'no such slot' }
          for (const s of subscribers) s.write(publish(`device/${MOCK_SERIAL}/report`, Buffer.from(JSON.stringify({ print: answer }))))
          if (!fx) return
          fx.material = String(pr.tray_type)
          fx.color = `#${String(pr.tray_color).slice(0, 6).toLowerCase()}`
          extra.trays = { ...extra.trays, [slot]: { info: String(pr.tray_info_idx), min: Number(pr.nozzle_temp_min), max: Number(pr.nozzle_temp_max) } }
          log.push(`ams_filament_setting ${JSON.stringify({ ams_id: pr.ams_id, slot_id: pr.slot_id, tray_id: pr.tray_id, tray_info_idx: pr.tray_info_idx, setting_id: pr.setting_id, tray_color: pr.tray_color, nozzle_temp_min: pr.nozzle_temp_min, nozzle_temp_max: pr.nozzle_temp_max, tray_type: pr.tray_type })}`)
          break
        }
        case 'gcode_file': m.start(String(pr.param).replace(/^\/sdcard\//, '')); extra.skipped = []; extra.printError = 0; break
        default: return
      }
      broadcast()
    } catch {
      // A rejected command leaves the state unchanged, as the real printer does.
    }
  }

  // FTPS on an ephemeral port (990 on a real printer), implicit TLS, passive mode only.
  const ftp = createTlsServer(tls, (ctl: TLSSocket) => {
    let authed = false
    let user = ''
    let dataServer: Server | undefined
    let dataReady: Promise<TLSSocket> | undefined
    const reply = (s: string) => ctl.write(`${s}\r\n`)
    ctl.on('error', () => undefined)
    reply('220 sx mock ftps')
    let buf = ''
    ctl.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        void command(line)
      }
    })
    const command = async (line: string) => {
      const [cmd, ...rest] = line.split(' ')
      const arg = rest.join(' ')
      switch ((cmd ?? '').toUpperCase()) {
        case 'USER': user = arg; reply('331 password please'); break
        case 'PASS': authed = user === 'bblp' && arg === MOCK_ACCESS_CODE; reply(authed ? '230 ok' : '530 login incorrect'); break
        case 'PBSZ': reply('200 ok'); break
        case 'PROT': reply('200 ok'); break
        case 'TYPE': reply('200 ok'); break
        case 'PASV': {
          dataServer = createTlsServer(tls)
          dataReady = new Promise<TLSSocket>((resolve) => dataServer?.once('secureConnection', resolve))
          const port = await listen(dataServer)
          reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`)
          break
        }
        case 'STOR': {
          if (!authed || !dataReady) { reply('530 not logged in'); break }
          if (extra.developerMode === false) { log.push(`refused STOR ${arg}`); reply('550 not authorized'); break }
          const name = arg
          reply('150 send it')
          const sock = await dataReady
          const chunks: Buffer[] = []
          sock.on('data', (c: Buffer) => chunks.push(c))
          await new Promise<void>((r) => sock.on('end', () => r()))
          m.upload(name, Buffer.concat(chunks))
          sock.end()
          dataServer?.close()
          reply('226 transfer complete')
          break
        }
        case 'LIST': {
          if (!authed || !dataReady) { reply('530 not logged in'); break }
          const dir = arg.replace(/^\//, '')
          if (dir !== '' && dir !== 'cache') { reply('550 no such folder'); break }
          reply('150 listing')
          const sock = await dataReady
          const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
          const line = (f: { name: string; size: number; modified: number }) => {
            const d = new Date(f.modified * 1000)
            const p2 = (n: number) => String(n).padStart(2, '0')
            return `-rw-rw-rw- 1 root root ${f.size} ${months[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} ${f.name}`
          }
          const rows = dir === 'cache' ? [] : ['drwxrwxrwx 1 root root 0 Jan 01 2025 cache', 'drwxrwxrwx 1 root root 0 Jan 01 2025 timelapse', ...[...m.files.values()].map(line)]
          sock.end(rows.map((r) => `${r}\r\n`).join(''))
          dataServer?.close()
          reply('226 transfer complete')
          break
        }
        case 'QUIT': reply('221 bye'); ctl.end(); break
        default: reply('502 not implemented')
      }
    }
  })

  // Port 6000 JPEG stream: 80 byte auth packet in, one frame out.
  const camera = createTlsServer(tls, (sock: TLSSocket) => {
    sock.on('error', () => undefined)
    log.push('camera 6000 connect')
    if (rtspModel(extra)) return void sock.destroy()
    let got = Buffer.alloc(0)
    sock.on('data', (d: Buffer) => {
      got = Buffer.concat([got, d])
      if (got.length < 80) return
      const user = got.toString('utf8', 16, 48).replace(/\0+$/, '')
      const pass = got.toString('utf8', 48, 80).replace(/\0+$/, '')
      if (user !== 'bblp' || pass !== MOCK_ACCESS_CODE) return void sock.destroy()
      // The picture is the machine's camera frame (`POST /camera`, or `POST /bambu {cameraFrame, cameraFrameFile}`).
      const frame = () => {
        const pic = m.frame()
        const head = Buffer.alloc(16)
        head.writeUInt32LE(pic.length, 0)
        head.writeUInt32LE(1, 8)
        return Buffer.concat([head, pic])
      }
      // The real camera streams for as long as the socket is open.
      sock.write(frame())
      const timer = setInterval(() => sock.write(frame()), 100)
      sock.on('close', () => clearInterval(timer))
    })
  })

  // X1 and H2 series: RTSPS on port 322 with the same login, Digest.
  // The login follows the control server: `cameraCode` and `digestQop` change it between connections.
  const login = {
    user: 'bblp',
    scheme: 'digest' as const,
    get pass() { return extra.cameraCode ?? MOCK_ACCESS_CODE },
    get qop() { return extra.digestQop === true },
  }
  // live555 holds a session a while after its connection drops without TEARDOWN.
  const rtsps = await startRtsp({ tls, login, oneSession: { holdMs: 3000 }, sharedLog: log, dropPlay: () => (extra.dropPlays ?? 0) > 0 && (extra.dropPlays = (extra.dropPlays ?? 0) - 1, true), dropWithinMs: () => extra.dropWithinMs ?? 0, stalled: (startedAt) => extra.stalledAt !== undefined && startedAt <= extra.stalledAt, path: '/streaming/live/1', accept: () => extra.liveview !== false, inBand: () => extra.inBandParameterSets === true })

  // SSDP on a loopback UDP port (2021 and 1990 on a real printer): a search for Bambu printers gets
  // the answer by unicast, as a real printer gives it.
  const ssdp = createSocket('udp4')
  ssdp.on('message', (msg, from) => {
    const text = msg.toString('utf8')
    if (!text.startsWith('M-SEARCH') || !text.includes('bambulab')) return
    log.push('ssdp search')
    ssdp.send(ssdpAnswer(extra, '127.0.0.1'), from.port, from.address)
  })
  await new Promise<void>((r) => ssdp.bind(0, '127.0.0.1', r))

  const ports = { mqtt: await listen(mqtt), ftp: await listen(ftp), camera: await listen(camera), rtsps: rtsps.port, ssdp: ssdp.address().port }
  return { handles: { mqtt, ftp, camera, rtsps, ssdp }, ports, serial: MOCK_SERIAL, accessCode: MOCK_ACCESS_CODE, extra }
}
