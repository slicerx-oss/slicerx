// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An ONVIF camera fake: WS-Discovery over UDP and the device and media SOAP services over HTTP, with
// the WS-Security UsernameToken digest check real cameras make. GetStreamUri deliberately reports a
// foreign host (10.9.9.9), as cameras behind NAT or in containers do; the connector must use the
// address it reached the camera at instead.
import { createHash } from 'node:crypto'
import { createSocket, type Socket } from 'node:dgram'
import type { Server } from 'node:http'
import { listen } from './http-util.ts'

export interface OnvifOptions {
  login?: { user: string; pass: string }
  rtspPort: number
  rtspPath: string
}

export interface RunningOnvif {
  server: Server
  http: number
  discovery: Socket
  discoveryPort: number
}

const tag = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`).exec(xml)?.[1]

function authorized(o: OnvifOptions, xml: string): boolean {
  if (!o.login) return true
  const user = tag(xml, 'Username')
  const digest = tag(xml, 'Password')
  const nonce = tag(xml, 'Nonce')
  const created = tag(xml, 'Created')
  if (user !== o.login.user || !digest || !nonce || !created) return false
  const expect = createHash('sha1').update(Buffer.from(nonce, 'base64')).update(created).update(o.login.pass).digest('base64')
  return digest === expect
}

const envelope = (body: string) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>${body}</s:Body></s:Envelope>`

export async function startOnvif(o: OnvifOptions): Promise<RunningOnvif> {
  let port = 0
  const { server, port: httpPort } = await listen((req) => {
    const xml = req.body.toString('utf8')
    const fault = { status: 400, type: 'application/soap+xml', body: envelope('<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code></s:Fault>') }
    if (req.method !== 'POST') return { status: 405 }
    if (!authorized(o, xml)) return { ...fault, status: 401 }
    if (xml.includes('GetCapabilities')) {
      return { type: 'application/soap+xml', body: envelope(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>http://127.0.0.1:${port}/onvif/device_service</tt:XAddr></tt:Device><tt:Media><tt:XAddr>http://127.0.0.1:${port}/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`) }
    }
    if (xml.includes('GetProfiles')) {
      return { type: 'application/soap+xml', body: envelope('<trt:GetProfilesResponse><trt:Profiles token="prof_mjpeg" fixed="true"><tt:Name>mjpeg</tt:Name><tt:VideoEncoderConfiguration token="e1"><tt:Encoding>JPEG</tt:Encoding></tt:VideoEncoderConfiguration></trt:Profiles><trt:Profiles token="prof_h264" fixed="true"><tt:Name>main</tt:Name><tt:VideoEncoderConfiguration token="e2"><tt:Encoding>H264</tt:Encoding></tt:VideoEncoderConfiguration></trt:Profiles></trt:GetProfilesResponse>') }
    }
    if (xml.includes('GetStreamUri')) {
      const token = tag(xml, 'ProfileToken')
      // Only the H.264 profile leads to the camera's real stream.
      const uri = token === 'prof_h264' ? `rtsp://10.9.9.9:${o.rtspPort}${o.rtspPath}` : 'rtsp://10.9.9.9:1/mjpeg'
      return { type: 'application/soap+xml', body: envelope(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>${uri}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`) }
    }
    return fault
  })
  port = httpPort

  const discovery = createSocket('udp4')
  discovery.on('message', (msg, rinfo) => {
    if (!msg.toString('utf8').includes('Probe')) return
    const reply = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><s:Body><d:ProbeMatches><d:ProbeMatch><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/name/Mock%20Cam onvif://www.onvif.org/hardware/SX-1</d:Scopes><d:XAddrs>http://127.0.0.1:${httpPort}/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`
    discovery.send(reply, rinfo.port, rinfo.address)
  })
  await new Promise<void>((r) => discovery.bind(0, '127.0.0.1', r))
  return { server, http: httpPort, discovery, discoveryPort: discovery.address().port }
}
