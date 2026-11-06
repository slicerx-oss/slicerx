// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A 3MF part of a type no slicer writes is a normal part everywhere: the app on the real engine, the engine's own
// reader (sx-geom format.read3mf), the command line's slice and slicerx_design_open in the MCP server all read the
// same parts for the same file. Runs where the core wasm (packages/geom/wasm/scripts/build.sh, or SX_GEOM_CORE_WASM)
// and sx with sx-geom beside it (cargo build -p sx-cli -p sx-geom, or SLICERX_TEST_SX_BIN) are built.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createContext, serverTools } from '@slicerx/mcp'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { zip } from '../src/export/zip'
import { setGeomProvider } from '../src/geom/client'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { binBuilt, GEOM_BUILD, SX_BUILD } from './binaries'
import { wasmBuilt } from './geom-engine'

const root = resolve(__dirname, '..', '..', '..')
const wasm = process.env['SX_GEOM_CORE_WASM'] ?? join(root, 'packages/geom/wasm/pkg/sx_geom_core.wasm')
const exe = process.platform === 'win32' ? '.exe' : ''
const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? join(root, 'target/release', `sx${exe}`)
const sxGeomBin = process.env['SLICERX_SX_GEOM_BIN'] ?? join(dirname(sxBin), `sx-geom${exe}`)
const ready = wasmBuilt(wasm) && binBuilt(sxBin, SX_BUILD) && binBuilt(sxGeomBin, GEOM_BUILD)

const vertices = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
const mesh = `<mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${triangles.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
/** A bracket of two boxes side by side, its second part of a part type no slicer writes. */
const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources><object id="1" type="model">${mesh}</object><object id="2" type="model">${mesh}</object><object id="3" type="model"><components><component objectid="1"/><component objectid="2" transform="1 0 0 0 1 0 0 0 1 30 0 0"/></components></object></resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>`
const SETTINGS = `<?xml version="1.0"?><config><object id="3"><metadata key="name" value="Bracket"/><part id="1" subtype="normal_part"><metadata key="name" value="Body"/></part><part id="2" subtype="lattice_part"><metadata key="name" value="Gear"/></part></object></config>`

const dir = mkdtempSync(join(tmpdir(), 'unknown-part-type-parity-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = join(dir, 'bracket.3mf')
writeFileSync(file, zip([{ name: '3D/3dmodel.model', data: MODEL }, { name: 'Metadata/model_settings.config', data: SETTINGS }]))

type Run = (a: unknown, c: unknown) => Promise<Record<string, unknown>>
type Tool = { name: string; input: { parse: (a: unknown) => unknown }; run: Run }

describe.skipIf(!ready)('a part of a type no slicer writes, in the app, the engine and the MCP server', () => {
  it('is the same normal part in each', async () => {
    // The app, on the real engine.
    const engine = (await WebAssembly.instantiate(readFileSync(wasm), {})).instance.exports as unknown as GeomExports
    readProjectsWithGeom(true)
    setGeomProvider({ call: async <T,>(op: string, r: unknown) => callEngine(engine, op, r) as T })
    let app: string[]
    try {
      const p = await readProject(new Uint8Array(readFileSync(file)), { widthMm: 256, depthMm: 256 })
      expect(p.plates[0]!.objects[0]!.volumes).toEqual([])
      app = p.plates[0]!.objects[0]!.parts.map((q) => q.name)
    } finally {
      setGeomProvider(null)
      readProjectsWithGeom(true)
    }

    // The engine's own reader: the parts it reads as normal, the ones the command line slices.
    const read = JSON.parse(execFileSync(sxGeomBin, ['format.read3mf'], { input: JSON.stringify({ data: { path: file } }), maxBuffer: 64 << 20 }).toString()) as { objects: { parts: { name: string; kind: string }[] }[] }
    const geom = read.objects.flatMap((o) => o.parts.filter((q) => q.kind === 'normal').map((q) => q.name))

    // The command line's slice prints the part.
    const slice = spawnSync(sxBin, ['slice', file, '-o', join(dir, 'bracket.gcode')], { encoding: 'utf8' })
    expect(slice.status, slice.stderr).toBe(0)
    expect(slice.stderr).toContain('Gear: part type lattice_part is not one this engine knows; it prints as a normal part')
    expect(existsSync(join(dir, 'bracket.gcode'))).toBe(true)

    // The MCP server's read-back.
    const ctx = await createContext({ engine: 'sx', sxBin, sxGeomBin, allowDirs: [dir], outDir: join(dir, 'out'), printers: 'off' })
    const tool = serverTools(ctx).find((t) => t.name.endsWith('design.open') || t.name.endsWith('design_open')) as unknown as Tool
    const r = await tool.run(tool.input.parse({ path: file }), { progress: () => {} })
    const out = ((r['structured'] as Record<string, unknown> | undefined)?.['output'] ?? r['output'] ?? r['structured']) as { designs: { parts: { name: string }[]; leftOut?: string[] }[] }
    const mcp = out.designs.flatMap((d) => d.parts.map((q) => q.name))
    expect(out.designs.flatMap((d) => d.leftOut ?? [])).toEqual([])

    expect(app).toEqual(['Body', 'Gear'])
    expect({ app, geom, mcp }).toEqual({ app: geom, geom, mcp: geom })
  }, 60_000)
})
