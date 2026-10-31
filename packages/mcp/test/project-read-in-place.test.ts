// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// readProjectFile and objectLayerHeights read a project in place: the ZIP's end record, its directory and the entries
// they need, never the whole file, and they close the file whatever happens. node:fs is wrapped to count the bytes
// read and the files opened and closed.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { objectLayerHeights, readProjectFile } from '../src/projectfile'
import { readZip, writeZip } from '../src/zip'

const io = vi.hoisted(() => ({ open: new Set<number>(), bytes: 0, opened: 0, whole: [] as string[] }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const counted = {
    ...fs,
    openSync: ((...a: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...a)
      io.open.add(fd)
      io.opened++
      return fd
    }) as typeof fs.openSync,
    closeSync: ((fd: number) => {
      io.open.delete(fd)
      fs.closeSync(fd)
    }) as typeof fs.closeSync,
    readSync: ((fd: number, b: NodeJS.ArrayBufferView, off: number, len: number, at: number) => {
      const n = fs.readSync(fd, b, off, len, at)
      io.bytes += n
      return n
    }) as typeof fs.readSync,
    readFileSync: ((...a: Parameters<typeof fs.readFileSync>) => {
      io.whole.push(String(a[0]))
      return fs.readFileSync(...a)
    }) as typeof fs.readFileSync,
  }
  return { ...counted, default: counted }
})

const dir = mkdtempSync(join(tmpdir(), 'sx-project-read-'))
const md = (k: string, v: string) => `<metadata key="${k}" value="${v}"/>`
/** Megabytes of text that hardly compress, as a mesh's coordinates in a part of the file. */
const bulk = (mb: number) => `<!-- ${randomBytes(mb * 768 * 1024).toString('base64')} -->`

/**
 * A Bambu Studio style project with an object at its own 0.3 mm layer height: its geometry in 3D/Objects (`mb`
 * megabytes) or, with `inline`, in the main model before the build, as a PrusaSlicer project has it.
 */
function project(name: string, mb: number, inline = false): string {
  const object = `<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object>`
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.03.00.70</metadata><resources>${inline ? bulk(mb) : ''}${object}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`
  const settings = `<config><object id="1">${md('name', 'cone')}${md('extruder', '1')}${md('layer_height', '0.3')}</object><plate>${md('plater_id', '1')}${md('plater_name', 'first')}<model_instance>${md('object_id', '1')}</model_instance></plate></config>`
  const path = join(dir, name)
  writeFileSync(path, writeZip([
    { name: '3D/3dmodel.model', data: main },
    ...(inline ? [] : [{ name: '3D/Objects/object_1.model', data: bulk(mb) }]),
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ wall_loops: '3', filament_type: ['PLA'] }) },
    { name: 'Metadata/model_settings.config', data: settings },
  ]))
  return path
}

beforeEach(() => {
  io.bytes = 0
  io.opened = 0
  io.whole = []
})

describe('a project file read in place', () => {
  it('reads its settings without the geometry, then its layer heights without reading it again', () => {
    const path = project('objects.3mf', 6)
    expect(statSync(path).size).toBeGreaterThan(4 * 1024 * 1024)
    const read = readProjectFile(path)
    expect(read.summary.plates).toEqual([{ index: 1, name: 'first', objects: 1 }])
    expect(read.summary.import_report.source).toBe('BambuStudio-02.03.00.70')
    expect(io.bytes).toBeLessThan(128 * 1024)
    expect(io.whole).not.toContain(path)
    const opened = io.opened
    expect(objectLayerHeights(read, 1)).toEqual([{ name: 'cone', layer_height: 0.3 }])
    expect(io.opened).toBe(opened)
    // From the path alone it reads the directory and model_settings.config.
    io.bytes = 0
    expect(objectLayerHeights(path, 1)).toEqual([{ name: 'cone', layer_height: 0.3 }])
    expect(io.bytes).toBeLessThan(128 * 1024)
    expect(io.whole).not.toContain(path)
    expect(io.open.size).toBe(0)
  })

  it("reads the app's name from the start of a main model that holds the geometry", () => {
    const path = project('inline.3mf', 6, true)
    const read = readProjectFile(path)
    expect(read.summary.import_report.source).toBe('BambuStudio-02.03.00.70')
    expect(io.bytes).toBeLessThan(128 * 1024)
    expect(io.whole).not.toContain(path)
    expect(io.open.size).toBe(0)
  })

  it('closes the file when the read fails', () => {
    const notZip = join(dir, 'not-a-zip.3mf')
    writeFileSync(notZip, 'not a zip at all')
    const noModel = join(dir, 'no-model.3mf')
    writeFileSync(noModel, writeZip([{ name: 'Metadata/project_settings.config', data: '{}' }]))
    // model_settings.config's directory entry names a compression method no reader has.
    const damaged = join(dir, 'damaged.3mf')
    const bytes = writeZip([{ name: '3D/3dmodel.model', data: '<model/>' }, { name: 'Metadata/model_settings.config', data: '<config/>' }])
    bytes.writeUInt16LE(99, bytes.lastIndexOf(Buffer.from('Metadata/model_settings.config')) - 46 + 10)
    writeFileSync(damaged, bytes)
    expect(() => readProjectFile(notZip)).toThrow('not-a-zip.3mf is not a ZIP archive')
    expect(() => objectLayerHeights(notZip)).toThrow('not-a-zip.3mf is not a ZIP archive')
    expect(() => readProjectFile(noModel)).toThrow('no-model.3mf has no 3D model part')
    expect(() => readProjectFile(damaged)).toThrow('damaged.3mf: Metadata/model_settings.config uses ZIP method 99, which is not supported')
    expect(() => objectLayerHeights(damaged)).toThrow('damaged.3mf: Metadata/model_settings.config uses ZIP method 99, which is not supported')
    expect(io.opened).toBe(5)
    expect(io.open.size).toBe(0)
  })
})

describe('the start of a ZIP entry', () => {
  it('is the entry\'s first bytes, inflating only as far as it takes', () => {
    const big = Buffer.from(bulk(1))
    const zip = readZip(writeZip([{ name: 'big', data: big }, { name: 'small', data: 'short' }]))
    expect(zip.head('big', 300_000)).toEqual(big.subarray(0, 300_000))
    expect(zip.head('big', 10)).toEqual(big.subarray(0, 10))
    expect(zip.head('big', big.length + 10)).toEqual(big)
    expect(zip.head('small', 4096)?.toString()).toBe('short')
    expect(zip.head('missing', 4096)).toBeUndefined()
  })
})
