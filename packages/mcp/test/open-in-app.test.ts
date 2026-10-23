// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_open_in_app hands every type the desktop app opens from the system (projects, models, STEP and G-code) to
// the app through the system's opener, and refuses anything else.
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveModel } from '../src/models'
import { APP_OPENS, openerFor, openInApp } from '../src/open-in-app'
import { connect, data } from './helpers'

// The system opener the tool starts is recorded and reported as started, so no app opens during a test.
const spawned = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...real,
    spawn: (cmd: string, args: string[]) => {
      spawned.push([cmd, ...args])
      const child = Object.assign(new EventEmitter(), { unref() {} })
      setImmediate(() => child.emit('spawn'))
      return child
    },
  }
})

const TYPES = '.sx3mf, .3mf, .sxlock, .stl, .obj, .amf, .step, .stp or .gcode'
const DESKTOP = resolve(__dirname, '../../../apps/desktop/src-tauri')

describe('open in the app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-open-'))
  const project = join(dir, 'clip.sx3mf')
  writeFileSync(project, 'design')

  it('uses the opener of each system', () => {
    expect(openerFor('darwin', project)).toEqual({ cmd: 'open', args: [project] })
    expect(openerFor('linux', project)).toEqual({ cmd: 'xdg-open', args: [project] })
    expect(openerFor('win32', project)).toEqual({ cmd: 'cmd', args: ['/c', 'start', '""', project] })
  })

  it('hands a project to the opener and says how', async () => {
    const calls: string[][] = []
    const r = await openInApp(project, async (cmd, args) => void calls.push([cmd, ...args]), 'darwin')
    expect(calls).toEqual([['open', project]])
    expect(r).toEqual({ file: project, command: `open ${project}` })
  })

  it('hands a STEP model to the opener, as .step or .stp in any case', async () => {
    const files = ['bracket.step', 'bracket.stp', 'HOUSING.STP'].map((name) => join(dir, name))
    for (const f of files) writeFileSync(f, 'ISO-10303-21;')
    const calls: string[][] = []
    for (const f of files) await openInApp(f, async (cmd, args) => void calls.push([cmd, ...args]), 'win32')
    expect(calls).toEqual(files.map((f) => ['cmd', '/c', 'start', '""', f]))
  })

  it('opens what the desktop app takes from the system: its accept list and its file associations', () => {
    const accepted = /const EXTENSIONS: \[&str; \d+\] = \[([^\]]*)\]/.exec(readFileSync(join(DESKTOP, 'src/opened.rs'), 'utf8'))?.[1]
    const fromShell = [...(accepted ?? '').matchAll(/"(\w+)"/g)].map((m) => `.${m[1]}`)
    const conf = JSON.parse(readFileSync(join(DESKTOP, 'tauri.conf.json'), 'utf8')) as { bundle: { fileAssociations: { ext: string[] }[] } }
    const associated = conf.bundle.fileAssociations.flatMap((a) => a.ext.map((e) => `.${e}`))
    expect([...APP_OPENS].sort()).toEqual([...fromShell].sort())
    expect([...APP_OPENS].sort()).toEqual([...associated].sort())
  })

  it('hands every other type the app opens to the opener', async () => {
    const files = ['locked.sxlock', 'part.obj', 'part.amf', 'plate.gcode'].map((name) => join(dir, name))
    for (const f of files) writeFileSync(f, 'x')
    const calls: string[][] = []
    for (const f of files) await openInApp(f, async (cmd, args) => void calls.push([cmd, ...args]), 'linux')
    expect(calls).toEqual(files.map((f) => ['xdg-open', f]))
  })

  it('refuses a file the app does not open, naming the types it opens, and a missing one', async () => {
    const run = async () => {
      throw new Error('should not run')
    }
    for (const name of ['notes.txt', 'part.igs', 'plate.json', 'plate.gco']) {
      const file = join(dir, name)
      writeFileSync(file, 'x')
      await expect(openInApp(file, run)).rejects.toMatchObject({ code: 'unsupported_format', message: `${name} is not a file the app opens (${TYPES})` })
    }
    await expect(openInApp(join(dir, 'gone.3mf'), run)).rejects.toMatchObject({ code: 'invalid_model' })
    await expect(openInApp(join(dir, 'gone.step'), run)).rejects.toMatchObject({ code: 'invalid_model' })
  })

  it('leaves STEP out of the model tools, which take meshes only', async () => {
    const step = join(dir, 'bracket.step')
    const policy = { allowDirs: [dir], outDir: join(dir, 'out'), allowUrls: false }
    await expect(resolveModel(policy, step)).rejects.toMatchObject({ code: 'unsupported_format' })
    expect(await resolveModel(policy, step, APP_OPENS)).toBe(realpathSync(step))
  })
})

describe('slicerx_open_in_app over MCP', () => {
  beforeEach(() => void spawned.splice(0))
  afterEach(() => void vi.unstubAllGlobals())

  it('says which types it opens, STEP among them', async () => {
    const h = await connect()
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_open_in_app')
    expect(tool?.description).toContain(`(${TYPES})`)
    expect(tool?.description).toMatch(/A STEP file \(\.step or \.stp\)/)
    expect(JSON.stringify(tool?.inputSchema)).toContain(`a ${TYPES} file`)
  })

  it('hands each type the app opens to the app through the system opener', async () => {
    const h = await connect()
    const names = APP_OPENS.map((ext) => `part${ext}`)
    expect(names).toEqual(['part.sx3mf', 'part.3mf', 'part.sxlock', 'part.stl', 'part.obj', 'part.amf', 'part.step', 'part.stp', 'part.gcode'])
    for (const name of names) {
      const file = join(h.dir, name)
      writeFileSync(file, 'ISO-10303-21;')
      const r = await h.call('slicerx_open_in_app', { file })
      expect(r.isError).toBeFalsy()
      const real = realpathSync(file)
      const { cmd, args } = openerFor(process.platform, real)
      expect(data(r)).toEqual({ file: real, command: [cmd, ...args].join(' ') })
      expect(spawned.at(-1)).toEqual([cmd, ...args])
    }
    expect(spawned).toHaveLength(names.length)
  })

  it('downloads a STEP model from a link under the same size limit, then hands it over', async () => {
    const h = await connect()
    vi.stubGlobal('fetch', async (url: URL) => (url.pathname.endsWith('big.step') ? new Response('x', { headers: { 'content-length': String(300 * 1024 * 1024) } }) : new Response('ISO-10303-21;')))
    const r = await h.call('slicerx_open_in_app', { file: 'https://models.example/parts/bracket.step' })
    expect(r.isError).toBeFalsy()
    const file = data<{ file: string }>(r).file
    expect(file.startsWith(join(h.dir, 'out', 'downloads'))).toBe(true)
    expect(file.endsWith('bracket.step')).toBe(true)
    expect(spawned).toHaveLength(1)
    const big = await h.call('slicerx_open_in_app', { file: 'https://models.example/parts/big.step' })
    expect(big.isError).toBe(true)
    expect(data<{ error: { code: string } }>(big).error.code).toBe('download_failed')
    expect(spawned).toHaveLength(1)
  })

  it('refuses another type as unsupported_format, lists the types it opens, and starts nothing', async () => {
    const h = await connect()
    for (const ext of ['.txt', '.json', '.igs']) {
      const file = join(h.dir, `part${ext}`)
      writeFileSync(file, 'x')
      const r = await h.call('slicerx_open_in_app', { file })
      expect(r.isError).toBe(true)
      expect(data(r)).toMatchObject({ error: { code: 'unsupported_format', message: `Unsupported model type "${ext}". Use .sx3mf, .3mf, .sxlock, .stl, .obj, .amf, .step, .stp, .gcode.` } })
    }
    expect(spawned).toEqual([])
  })

  it('names the types it opens for a missing file, while a model tool names its own', async () => {
    const h = await connect()
    const gone = join(h.dir, 'gone.gcode')
    const r = await h.call('slicerx_open_in_app', { file: gone })
    expect(r.isError).toBe(true)
    expect(data(r)).toMatchObject({ error: { code: 'file_not_found', message: `File not found: ${gone}. Pass an absolute path to a ${TYPES} file.` } })
    const model = join(h.dir, 'gone.stl')
    const sliced = await h.call('slicerx_slice_file', { model })
    expect(sliced.isError).toBe(true)
    expect(data(sliced)).toMatchObject({ error: { code: 'file_not_found', message: `File not found: ${model}. Pass an absolute path to a .stl, .3mf, .sx3mf or .obj file.` } })
    expect(spawned).toEqual([])
  })
})
