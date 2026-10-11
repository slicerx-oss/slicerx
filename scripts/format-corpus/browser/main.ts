// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One reader of a 3MF project in the page, for scripts/format-corpus/browser.mjs: `?reader=ts` scans it in
// TypeScript (project-scan.ts), `?reader=geom` reads it with the geometry engine's format reader, `?reader=none`
// only fetches the file. Both then lay it out (import3mf.ts projectOf). The times are in window.sxBench.
import { projectOf, readProjectsWithGeom, scanProjectFile } from '../../../packages/app/src/export/import3mf'
import { scanProject } from '../../../packages/app/src/export/project-scan'
import { setGeomProvider } from '../../../packages/app/src/geom/client'
import { callEngine, type GeomExports } from '../../../packages/app/src/geom/engine-call'

declare global {
  interface Window {
    sxBench?: { times: number[]; objects: number; parts: number; error?: string }
  }
}

const q = new URLSearchParams(location.search)
const reader = q.get('reader') ?? 'ts'
const repeats = Number(q.get('repeats') ?? 3)
const BED = { widthMm: 256, depthMm: 256 }

async function run(): Promise<void> {
  const bytes = new Uint8Array(await (await fetch(q.get('file') ?? '')).arrayBuffer())
  if (reader === 'none') {
    window.sxBench = { times: [], objects: 0, parts: 0 }
    return
  }
  if (reader === 'geom') {
    const wasm = new URL('../../../packages/geom/wasm/pkg/sx_geom_core.wasm', import.meta.url)
    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasm), {})
    const x = instance.exports as unknown as GeomExports
    setGeomProvider({ call: async <T,>(op: string, request: unknown) => callEngine(x, op, request) as T })
  }
  readProjectsWithGeom(reader === 'geom')
  const times: number[] = []
  let objects = 0
  let parts = 0
  for (let i = 0; i < repeats; i++) {
    const t = performance.now()
    const scanned = reader === 'geom' ? await scanProjectFile(bytes) : await scanProject(bytes)
    if (reader === 'geom' && !('geom' in scanned && scanned.geom)) throw new Error('the engine did not read it')
    const project = await projectOf(scanned, BED)
    times.push(performance.now() - t)
    objects = project.plates.reduce((n, p) => n + p.objects.length, 0)
    parts = project.plates.reduce((n, p) => n + p.objects.reduce((m, o) => m + o.parts.length + o.volumes.length, 0), 0)
  }
  window.sxBench = { times, objects, parts }
}

run().catch((e: unknown) => {
  window.sxBench = { times: [], objects: 0, parts: 0, error: e instanceof Error ? e.message : String(e) }
})
