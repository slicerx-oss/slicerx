// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs the client against the real sx-cloud binary on its in-memory backend.
// Skipped unless the binary is built (`cargo build -p sx-cloud`).
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCloudClient } from '../src/client'
import { createDeliveryAgent } from '../src/delivery'
import type { ApprovalRequest } from '@slicerx/contracts'

const bin = fileURLToPath(new URL('../../../../../target/debug/sx-cloud', import.meta.url))
// Any resolved edition config with cloudSlicing on; the memory backend ignores its Supabase URL.
const config = fileURLToPath(
  new URL('../../../../../packages/edition-config/fixtures/fork-harbor.resolved.json', import.meta.url),
)
const TOKEN = 'sxk_integration_test_token'
let child: ChildProcess | null = null
let baseUrl = ''

function cubeStl(): Uint8Array {
  const s = 20
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ]
  const tris = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  const out = new Uint8Array(84 + tris.length * 50)
  const dv = new DataView(out.buffer)
  dv.setUint32(80, tris.length, true)
  tris.forEach((t, i) => {
    let at = 84 + i * 50 + 12
    for (const idx of t) {
      for (const c of v[idx] ?? []) {
        dv.setFloat32(at, c, true)
        at += 4
      }
    }
  })
  return out
}

describe.skipIf(!existsSync(bin))('sx-cloud service (memory backend)', () => {
  beforeAll(async () => {
    child = spawn(bin, [], {
      env: {
        ...process.env,
        SLICERX_CONFIG: config,
        SX_CLOUD_BACKEND: 'memory',
        SX_CLOUD_DEV_TOKEN: TOKEN,
        SX_CLOUD_BIND: '127.0.0.1:0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    baseUrl = await new Promise<string>((resolve, reject) => {
      let buf = ''
      child?.stderr?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const m = /listening on (http:\/\/\S+)/.exec(buf)
        if (m?.[1]) resolve(m[1])
      })
      child?.on('exit', (code) => reject(new Error(`sx-cloud exited with ${code}: ${buf}`)))
    })
  })

  afterAll(() => {
    child?.kill('SIGTERM')
  })

  it('slices a plate from bytes and delivers it after local approval', async () => {
    const client = createCloudClient({ baseUrl, credential: () => TOKEN })
    const about = await client.about()
    // The client's own error, if any, is the failure message.
    if (!about.ok) throw new Error(`/v1/about: ${about.code}: ${about.message}`)
    expect(about.value.sourceUrl).toMatch(/^https:\/\//)
    const device = await client.registerDevice('Workshop bridge', 'link')
    if (!device.ok) throw new Error(device.message)
    const printers = await client.setDevicePrinters(device.value.id, [{ localId: 'bay-1', name: 'Bay 1' }])
    if (!printers.ok) throw new Error(printers.message)

    const submitted = await client.slicePlate({
      name: 'Cube',
      meshes: { cube: cubeStl() },
      request: { plate: { objects: [{ id: 'cube', mesh: 'cube' }] }, config: { layer_height: 0.2 } },
      targetPrinterId: printers.value[0]?.id ?? '',
    })
    if (!submitted.ok) throw new Error(submitted.message)
    const seen: string[] = []
    const done = await client.waitForJob(submitted.value.id, {
      intervalMs: 50,
      onUpdate: (j) => seen.push(j.status),
    })
    if (!done.ok) throw new Error(done.message)
    expect(done.value.status).toBe('succeeded')
    expect(done.value.result?.layerCount).toBe(100)
    const gcode = await client.downloadGcode(done.value)
    expect(gcode.ok).toBe(true)

    const approvals: ApprovalRequest[] = []
    const printed: string[] = []
    const agent = createDeliveryAgent({
      client,
      deviceId: device.value.id,
      printers: {
        upload: (printerId, file) => Promise.resolve({ printerId, path: file.name, name: file.name }),
        start: (file) => {
          printed.push(file.name)
          return Promise.resolve()
        },
      },
      approvals: {
        register: (r) => {
          approvals.push(r)
          return Promise.resolve()
        },
        deny: () => Promise.resolve(),
      },
    })
    await agent.tick()
    expect(approvals).toHaveLength(1)
    expect(printed).toEqual([])
    await agent.resolve(approvals[0]?.id ?? '', {
      kind: 'approve',
      token: { requestId: approvals[0]?.id ?? '', token: 'local', expiresAt: '2026-01-01T00:05:00Z' },
    })
    expect(printed).toEqual(['Cube.gcode'])
    const open = await client.deliveries(device.value.id)
    expect(open.ok && open.value).toEqual([])
  })
})
