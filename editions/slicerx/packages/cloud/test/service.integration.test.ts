// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs the client against the real sx-cloud binary on its in-memory backend.
// Skipped unless the binary is built (`cargo build -p sx-cloud`). It is read from CARGO_TARGET_DIR when that is set,
// where cargo builds it, so a stale copy in the repo's own target folder is never the one tested.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCloudClient } from '../src/client'
import { createDeliveryAgent } from '../src/delivery'
import type { ApprovalRequest } from '@slicerx/contracts'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const bin = join(resolve(repo, process.env['CARGO_TARGET_DIR'] ?? 'target'), 'debug', 'sx-cloud')
// CI's rust tests crates part builds sx-cloud first and sets SLICERX_TEST_REQUIRE_SX=1: there a missing one fails the file.
if (!existsSync(bin) && process.env['SLICERX_TEST_REQUIRE_SX'] === '1') {
  throw new Error(`SLICERX_TEST_REQUIRE_SX=1 but there is nothing at ${bin}: build sx-cloud (cargo build -p sx-cloud)`)
}
// Any resolved edition config with cloudSlicing on; the memory backend ignores its Supabase URL.
const config = fileURLToPath(
  new URL('../../../../../packages/edition-config/fixtures/fork-harbor.resolved.json', import.meta.url),
)
const TOKEN = 'sxk_integration_test_token'
let child: ChildProcess | null = null
let baseUrl = ''

// The service's address, read from its startup log. sx-cloud writes that line to an unbuffered stderr in pieces (the
// text, the host, the port, the newline), so one read can end inside the address. Only a line that is complete counts:
// a cut address such as http://127.0 never answers and used to run into the test limit, and http://127.0.0.1 is refused
// at once, which was the failure with no clear cause.
function listeningUrl(log: string): string | null {
  return /listening on (http:\/\/\S+)\n/.exec(log)?.[1] ?? null
}

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

describe('reading the service address from its startup log', () => {
  const log = 'sx-cloud: memory backend; nothing is saved\nsx-cloud: listening on http://127.0.0.1:65040\nsx-cloud: browser pages allowed from tauri://localhost\n'
  it('waits for the whole line, however the reads are cut', () => {
    for (let at = 0; at <= log.length; at++) {
      const first = listeningUrl(log.slice(0, at))
      // Before the newline of the listening line arrives there is no address, never a cut one.
      expect(first === null || first === 'http://127.0.0.1:65040', `cut at ${at}: ${first}`).toBe(true)
    }
    expect(listeningUrl(log)).toBe('http://127.0.0.1:65040')
  })
})

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
        const url = listeningUrl(buf)
        if (url) resolve(url)
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
    if (!about.ok) throw new Error(`${baseUrl}/v1/about: ${about.code}: ${about.message}`)
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
