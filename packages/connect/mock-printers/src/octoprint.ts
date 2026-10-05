// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// OctoPrint REST fake: https://docs.octoprint.org/en/master/api/
import { JPEG, MockError, type MockMachine } from './machine.ts'
import { listen, mjpeg, readFilePart, type Handler } from './http-util.ts'

export async function startOctoPrint(m: MockMachine, opts: { apiKey?: string } = {}) {
  let port = 0
  const handler: Handler = async (req) => {
    if (opts.apiKey && req.headers['x-api-key'] !== opts.apiKey) return { status: 403, json: { error: 'Invalid API key' } }
    const p = req.path
    if (p === '/api/version') return { json: { api: '0.1', server: '1.10.0', text: 'OctoPrint mock' } }
    if (p === '/api/printerprofiles') return { json: { profiles: { _default: { id: '_default', name: 'Default', model: m.fx.model, current: true, default: true, extruder: { count: m.fx.nozzleCount, nozzleDiameter: 0.4, sharedNozzle: false } } } } }
    if (p === '/api/settings') {
      return { json: { webcam: { webcamEnabled: m.fx.cameraAvailable, snapshotUrl: m.fx.cameraAvailable ? `http://127.0.0.1:${port}/webcam/snapshot` : '', streamUrl: m.fx.cameraAvailable ? `http://127.0.0.1:${port}/webcam/stream` : '' } } }
    }
    if (p === '/webcam/snapshot') return { body: JPEG, type: 'image/jpeg' }
    if (p === '/webcam/stream') return { stream: mjpeg(JPEG) }
    if (p === '/api/printer' && req.method === 'GET') {
      if (m.state === 'offline') return { status: 409, body: 'Printer is not operational' }
      const flags = {
        operational: true,
        printing: m.state === 'printing' || m.state === 'preparing',
        paused: m.state === 'paused',
        error: m.state === 'error',
        ready: m.state === 'idle' || m.state === 'finished',
        closedOrError: false,
      }
      const temperature: Record<string, unknown> = {}
      m.fx.nozzles.forEach((n, i) => { temperature[`tool${i}`] = { actual: n.current, target: n.target } })
      if (m.fx.bed) temperature.bed = { actual: m.fx.bed.current, target: m.fx.bed.target }
      if (m.fx.chamber) temperature.chamber = { actual: m.fx.chamber.current, target: m.fx.chamber.target }
      return { json: { state: { text: m.state, flags }, temperature } }
    }
    if (p === '/api/job' && req.method === 'GET') {
      return {
        json: {
          job: { file: { name: m.job?.name ?? null } },
          progress: { completion: m.job ? m.job.progress * 100 : null, printTimeLeft: m.job?.timeLeftS ?? null },
          state: m.state,
        },
      }
    }
    if (p === '/api/files/local' && req.method === 'POST') {
      const f = await readFilePart(req)
      m.upload(f.name, f.data)
      return { status: 201, json: { files: { local: { name: f.name, path: f.name } }, done: true } }
    }
    const file = /^\/api\/files\/local\/(.+)$/.exec(p)
    if (file && req.method === 'POST') {
      const body = req.json() as { command?: string; print?: boolean }
      if (body.command !== 'select') throw new MockError(400, 'bad command')
      if (body.print) m.start(decodeURIComponent(file[1] ?? ''))
      return { status: 204 }
    }
    if (p === '/api/job' && req.method === 'POST') {
      const body = req.json() as { command?: string; action?: string }
      if (body.command === 'cancel') m.cancel()
      else if (body.command === 'pause' && body.action === 'pause') m.pause()
      else if (body.command === 'pause' && body.action === 'resume') m.resume()
      else throw new MockError(400, 'bad command')
      return { status: 204 }
    }
    if (p === '/api/printer/command' && req.method === 'POST') {
      m.gcode(String((req.json() as { command?: string }).command ?? ''))
      return { status: 204 }
    }
    throw new MockError(404, p)
  }
  const { server, port: bound } = await listen(handler)
  port = bound
  return { server, port }
}
