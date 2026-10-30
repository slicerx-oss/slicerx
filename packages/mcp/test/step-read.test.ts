// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_step_read, driven the way a client drives it: list it, read a STEP file back (objects, bodies, colors,
// triangle counts, boxes), write it as STL or OBJ into the output folder and feed that file to another tool, and get
// typed step_ refusals for files the reader refuses. Without @slicerx/step-reader installed the call says how to
// install it.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { stepModule } from '../src/toolbox/step-read'
import { connect, data, text } from './helpers'

const fixtures = join(import.meta.dirname, '..', '..', 'step-reader', 'test', 'fixtures')
type Info = { file: string; unit: string; triangles: number; objects: { name: string; triangles: number; bodies: { name: string; color: string | null; triangles: number; bounds: { min: number[]; max: number[] } }[] }[]; output?: { format: string; path: string; bytes: number } }

async function withServer(run: (h: Awaited<ReturnType<typeof connect>>, call: (args: Record<string, unknown>) => Promise<CallToolResult>) => Promise<void>) {
  const h = await connect()
  try {
    for (const f of ['assembly.step', 'assembly-colors.step', 'bracket-inch.stp', 'bracket-inch-bom.stp', 'empty.step']) copyFileSync(join(fixtures, f), join(h.dir, f))
    await run(h, async (args) => (await h.client.callTool({ name: 'slicerx_step_read', arguments: args })) as CallToolResult)
  } finally {
    await h.client.close()
  }
}

const load = stepModule.load
afterEach(() => void (stepModule.load = load))

describe('slicerx_step_read', () => {
  it('is listed with its input and output schemas', async () => {
    await withServer(async (h) => {
      const tool = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_step_read')
      expect(tool).toBeDefined()
      expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(['model', 'output', 'quality'])
      expect(tool!.outputSchema).toBeDefined()
      expect(tool!.description).not.toMatch(/IGES/i)
    })
  })

  it('reads a STEP file back: objects, bodies, colors, triangles and boxes in mm', async () => {
    await withServer(async (h, call) => {
      const r = await call({ model: join(h.dir, 'assembly-colors.step') })
      expect(r.isError).toBeFalsy()
      const info = data<Info>(r)
      expect(info.unit).toBe('millimeter')
      expect(info.triangles).toBe(328)
      expect(info.objects.map((o) => [o.name, o.bodies.map((b) => [b.name, b.color])])).toEqual([
        ['assembly-colors', [['base', '#ff0000'], ['post', null]]],
        ['cube', [['cube', '#0040ff']]],
      ])
      const cube = info.objects[1]!.bodies[0]!
      expect(cube.bounds.max.map((v, k) => Math.round((v - cube.bounds.min[k]!) * 1000) / 1000)).toEqual([10, 10, 10])
      expect(info.output).toBeUndefined()
      expect(text(r)).toContain('"triangles":328')
    })
  })

  it('reads a STEP file saved with a UTF-8 byte order mark like the same file without one', async () => {
    await withServer(async (h, call) => {
      const plain = data<Info>(await call({ model: join(h.dir, 'bracket-inch.stp') }))
      const r = await call({ model: join(h.dir, 'bracket-inch-bom.stp') })
      expect(r.isError, text(r)).toBeFalsy()
      const info = data<Info>(r)
      expect(info.unit).toBe('inch')
      expect(info.triangles).toBe(plain.triangles)
      expect(info.objects.map((o) => [o.name, o.bodies.map((b) => [b.name, b.triangles, b.bounds])])).toEqual([
        ['bracket-inch-bom', plain.objects[0]!.bodies.map((b) => [b.name, b.triangles, b.bounds])],
      ])
    })
  })

  it('writes STL and OBJ into the output folder, and the STL is a model the other tools take', async () => {
    await withServer(async (h, call) => {
      const stl = data<Info>(await call({ model: join(h.dir, 'bracket-inch.stp'), output: 'stl' }))
      expect(stl.output!.format).toBe('stl')
      expect(stl.output!.path.startsWith(join(h.dir, 'out', 'step'))).toBe(true)
      const bytes = readFileSync(stl.output!.path)
      expect(bytes.length).toBe(stl.output!.bytes)
      expect(bytes.readUInt32LE(80)).toBe(stl.triangles)
      // The written file passes the server's path checks as a model for another tool.
      const est = (await h.client.callTool({ name: 'slicerx_estimate_file', arguments: { model: stl.output!.path } })) as CallToolResult
      expect(est.isError, text(est)).toBeFalsy()

      const obj = data<Info>(await call({ model: join(h.dir, 'assembly-colors.step'), output: 'obj' }))
      const lines = readFileSync(obj.output!.path, 'utf8').split('\n')
      expect(lines.filter((l) => l.startsWith('o '))).toEqual(['o assembly-colors', 'o cube'])
      expect(lines.find((l) => l.startsWith('v '))!.split(' ')).toHaveLength(7)
    })
  })

  it('refuses with typed step_ codes and the reason after the file name', async () => {
    await withServer(async (h, call) => {
      writeFileSync(join(h.dir, 'not.step'), 'solid x\nendsolid x\n')
      writeFileSync(join(h.dir, 'blank.stp'), '')
      writeFileSync(join(h.dir, 'cut.step'), readFileSync(join(fixtures, 'assembly.step')).subarray(0, 5000))
      for (const [file, code] of [
        ['empty.step', 'step_no_solids'],
        ['not.step', 'step_not_step'],
        ['blank.stp', 'step_empty'],
        ['cut.step', 'step_unreadable'],
      ] as const) {
        const r = await call({ model: join(h.dir, file) })
        expect(r.isError).toBe(true)
        expect(text(r)).toMatch(new RegExp(`^Error: ${code}: ${file.replace('.', '\\.')} `))
        expect(data(r)).toMatchObject({ error: { code, details: { step_code: code.slice(5) } } })
      }
      // Not a STEP name: refused before reading, like any other wrong type.
      const stl = await call({ model: join(h.dir, 'cube.stl') })
      expect(data(stl)).toMatchObject({ error: { code: 'unsupported_format' } })
    })
  })

  it('keeps to the allowed directories', async () => {
    await withServer(async (_h, call) => {
      const r = await call({ model: join(fixtures, 'assembly.step') })
      expect(data(r)).toMatchObject({ error: { code: 'path_not_allowed' } })
    })
  })

  it('says how to install the reader when the package is missing', async () => {
    stepModule.load = () => Promise.reject(Object.assign(new Error("Cannot find package '@slicerx/step-reader' imported from /x/cli.js"), { code: 'ERR_MODULE_NOT_FOUND' }))
    await withServer(async (h, call) => {
      const r = await call({ model: join(h.dir, 'assembly.step') })
      expect(data(r)).toMatchObject({ error: { code: 'not_supported', details: { install: 'npm install @slicerx/step-reader' } } })
      expect(text(r)).toMatch(/needs the optional @slicerx\/step-reader package/)
    })
  })
})
