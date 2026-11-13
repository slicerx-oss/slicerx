// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in sx-geom for the served engine (geom-served.ts), shared by its tests: `served-engine-cli.ts serve` speaks
// the frame protocol of packages/geom/src/serve.rs (HELLO, then one frame answered per frame read), and any other
// argument is one call the way a per-call run makes it. Its kernel holds bodies by number while the process lives
// (`withKeys`) or hands them out as text (`save`); a box is three faces. Every call and every body it frees is logged
// to SX_STANDIN_LOG when set, one JSON line each, so a test can read what reached the engine.
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

type Req = Record<string, unknown>

const tri = (z: number) => [0, 0, z, 10, 0, z, 0, 10, z]

/** The kernel of one process. */
export function standInKernel() {
  const held = new Map<number, number>()
  let n = 0
  const log = (line: Record<string, unknown>) => {
    const to = process.env['SX_STANDIN_LOG']
    if (to) appendFileSync(to, `${JSON.stringify({ pid: process.pid, ...line })}\n`)
  }
  const make = (req: Req, faces: number) => {
    if (req['save']) return { bodySmb: `faces:${faces}` }
    held.set(++n, faces)
    return { body: n, bodyKeys: Array.from({ length: faces }, (_, i) => (req['keySalt'] as number ?? 0) + i + 1) }
  }
  const facesOf = (b: unknown): number => {
    if (typeof b === 'number') {
      const f = held.get(b)
      if (f === undefined) throw new Error('brep: body: no such body (freed, or from an earlier session)')
      return f
    }
    const smb = (b as { smb?: string } | null)?.smb
    if (typeof smb === 'string') return Number(smb.slice(6))
    throw new Error('brep: body: a body is expected')
  }
  const call = (op: string, req: Req): unknown => {
    log({ op, body: req['body'] ?? req['target'] ?? null, asText: typeof req['body'] === 'object' || typeof req['target'] === 'object' })
    switch (op) {
      case 'brep.count':
        return { bodies: held.size }
      case 'exact.ops':
        return { ops: ['sketch.loft'] }
      case 'sketch.loft':
        // an exact loft keeps its body as a kernel op does when asked (withKeys); a box-like body of four faces
        if (req['exact'] === true && req['withKeys'] === true) return make(req, 4)
        throw new Error('sketch.loft: only exact lofts kept by number here')
      case 'brep.extrude':
        if (req['target'] === undefined) return make(req, 3)
        return { ...make(req, facesOf(req['target']) + 1), touches: true }
      case 'brep.tessellate': {
        const faces = facesOf(req['body'])
        const positions = Array.from({ length: faces }, (_, i) => tri(i)).flat()
        return { positions, indices: positions.map((_, i) => i).slice(0, faces * 3), faceIds: Array.from({ length: faces }, (_, i) => i), faces: Array.from({ length: faces }, (_, id) => ({ id, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: id }, key: id + 1 })) }
      }
      case 'brep.free': {
        const b = req['body'] as number
        log({ freed: b })
        return { freed: held.delete(b) }
      }
      case 'test.exit':
        process.exit(3)
    }
    throw new Error(`${op}: not in this engine`)
  }
  return { call }
}

/** The stand-in as an executable sx-geom in `dir`: a script that runs served-engine-cli.ts, from the package so tsx resolves. */
export function standInBin(dir: string): string {
  const bin = join(dir, 'sx-geom')
  writeFileSync(bin, `#!/bin/sh\ncd "${resolve(__dirname, '..')}" && exec "${process.execPath}" --import tsx "${resolve(__dirname, 'served-engine-cli.ts')}" "$@"\n`)
  chmodSync(bin, 0o755)
  return bin
}
