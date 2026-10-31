// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slice reads the makers' presets of the printer it slices on, so the catalog loads them per printer and nozzle when a
// slice names that printer, not for every printer at once. Every key must hold what the eager load held.
import { copyFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EasyGoal, SettingValue } from '@slicerx/contracts'
import { EASY_GOALS } from '@slicerx/contracts'
import { hasResolved, listPrinterProfiles, resolvedNozzles, stockPrinter, stockProcess, type StockPrinter } from '@slicerx/settings'
import { describe, expect, it } from 'vitest'
import { DataStore, resolveDataPaths } from '../src/data'
import { loadPrinterNozzle, printerNozzles, ProfileCatalog, type PrinterStock } from '../src/profiles'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const TIERS = Object.keys(EASY_GOALS) as EasyGoal[]

/** The maps ProfileCatalog.prepare built before, for every printer, nozzle and tier at once. */
async function eager(): Promise<PrinterStock> {
  const maker = new Map<string, Record<string, SettingValue>>()
  for (const p of listPrinterProfiles()) {
    if (!hasResolved(p.id)) continue
    for (const nozzle of await resolvedNozzles(p.id)) {
      for (const tier of TIERS) maker.set(`${p.id}@${nozzle}:${tier}`, await stockProcess(p.id, tier, nozzle))
    }
  }
  const printers = new Map<string, StockPrinter>()
  for (const p of listPrinterProfiles()) {
    for (const nozzle of p.nozzles) {
      const stock = await stockPrinter(p.id, nozzle)
      if (stock) printers.set(`${p.id}@${nozzle}`, stock)
    }
  }
  return { maker, printers }
}

describe('makers\' presets loaded per printer and nozzle', () => {
  it('holds every printer x nozzle x tier key the eager load held, with the same values', async () => {
    const old = await eager()
    const now: PrinterStock = { printers: new Map(), maker: new Map() }
    for (const p of listPrinterProfiles()) for (const nozzle of await printerNozzles(p.id)) await loadPrinterNozzle(p.id, nozzle, now)
    expect(old.printers.size).toBeGreaterThan(100)
    expect(old.maker.size).toBeGreaterThan(400)
    expect([...now.printers.keys()].sort()).toEqual([...old.printers.keys()].sort())
    expect([...now.maker.keys()].sort()).toEqual([...old.maker.keys()].sort())
    for (const [k, v] of old.printers) expect(now.printers.get(k), k).toEqual(v)
    for (const [k, v] of old.maker) expect(now.maker.get(k), k).toEqual(v)
  })

  it('gives each prepared printer the eager maps\' machine, filament and supports on every nozzle', async () => {
    const old = await eager()
    const store = new DataStore(resolveDataPaths())
    for (const p of listPrinterProfiles()) {
      const catalog = new ProfileCatalog(store)
      await catalog.prepare([`machine:${p.id}`])
      for (const nozzle of p.nozzles) {
        const at = { printerId: p.id, nozzle }
        const stock = old.printers.get(`${p.id}@${nozzle}`)
        const key = `${p.id}@${nozzle}`
        expect(catalog.defaultFilament(at), key).toEqual(stock ? { name: stock.filamentName, config: stock.filament } : undefined)
        if (stock) expect(catalog.get(`machine:${p.id}`, at)?.config, key).toEqual(stock.machine)
        const own = old.maker.get(`${p.id}@${nozzle}:standard`)
        const supports = catalog.defaultSupports(at)
        if (own) for (const [k, v] of Object.entries(supports)) if (own[k] !== undefined) expect(v, `${key} ${k}`).toEqual(own[k])
      }
    }
  })

  it('loads only the printers a slice names, and refuses a lookup on one it was not given', async () => {
    const catalog = new ProfileCatalog(new DataStore(resolveDataPaths()))
    await catalog.prepare(['machine:bambu-a1', 'process:standard'])
    expect(catalog.get('process:standard', { printerId: 'bambu-a1' })).toBeDefined()
    expect(() => catalog.get('process:standard', { printerId: 'prusa-mk4' })).toThrow(/prepare must run with printer prusa-mk4/)
    expect(() => catalog.defaultSupports({ printerId: 'prusa-mk4' })).toThrow(/prepare must run with printer prusa-mk4/)
    await catalog.prepare([], ['prusa-mk4'])
    expect(catalog.defaultSupports({ printerId: 'prusa-mk4' })).toBeDefined()
    // An id that is no printer profile has no makers' presets to load.
    expect(catalog.defaultFilament({ printerId: 'no-such-printer' })).toBeUndefined()
  })

  it.skipIf(noSx())('prepares a project\'s own printer when the slice names no machine profile', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const model = join(h.dir, 'p1s-f1.3mf')
    copyFileSync(resolve(__dirname, '../../core/cli/tests/fixtures/color-change/p1s-f1.3mf'), model)
    const r = await h.call('slicerx_slice_file', { model, plate: 1, project_settings: true, profiles: ['process:standard'] })
    expect(r.isError, text(r)).toBeFalsy()
  })

  it.skipIf(noSx())('estimates a project on its own printer when the slice names no machine profile', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const model = join(h.dir, 'p1s-f1.3mf')
    copyFileSync(resolve(__dirname, '../../core/cli/tests/fixtures/color-change/p1s-f1.3mf'), model)
    const r = await h.call('slicerx_estimate_file', { model, plate: 1, project_settings: true, profiles: ['process:standard'] })
    expect(r.isError, text(r)).toBeFalsy()
  })
})

// Every tool that reads a printer's makers' presets, each on a printer its profiles do not name as machine:, on a server
// that has prepared nothing: none may answer that prepare did not run.
describe('tools on a printer the profiles do not name', () => {
  const notPrepared = /prepare must run/

  it('slices and estimates with a printer preset file', async () => {
    const h = await connect()
    const file = join(h.dir, 'Custom U1.json')
    writeFileSync(file, JSON.stringify({ type: 'machine', name: 'Custom U1', inherits: 'Snapmaker U1 (0.4 nozzle)', nozzle_diameter: ['0.6'] }))
    for (const tool of ['slicerx_slice_file', 'slicerx_estimate_file']) {
      for (const profiles of [[], ['process:standard'], ['process:slicerx-default']]) {
        const r = await h.call(tool, { model: join(h.dir, 'cube.stl'), profiles, profile_files: [file] })
        expect(r.isError, `${tool} ${profiles.join()} ${text(r)}`).toBeFalsy()
      }
    }
  })

  it('slices and estimates on a knowledge printer and on two machine profiles', async () => {
    const h = await connect()
    for (const tool of ['slicerx_slice_file', 'slicerx_estimate_file']) {
      for (const profiles of [['printer:bambu_a1'], ['printer:bambu_a1', 'process:fine'], ['machine:bambu-a1', 'process:standard', 'machine:prusa-mk4']]) {
        const r = await h.call(tool, { model: join(h.dir, 'cube.stl'), profiles, overrides: { nozzle_diameter: [0.6] } })
        expect(r.isError, `${tool} ${profiles.join()} ${text(r)}`).toBeFalsy()
      }
    }
  })

  it('shows a machine, a process and the default process', async () => {
    const h = await connect()
    for (const profile of ['machine:prusa-mk4', 'process:standard', 'process:slicerx-default', 'intent:strong', 'printer:bambu_x1c']) {
      const r = await h.call('slicerx_get_profile', { profile })
      expect(r.isError, `${profile} ${text(r)}`).toBeFalsy()
    }
  })

  it('opens a project on a printer and slices its plate', async () => {
    const h = await connect()
    expect(text(await h.call('slicerx_project_open', { printer: 'Bambu Lab X1 Carbon', filament: 'petg', profiles: ['machine:prusa-mk4', 'process:standard'] }))).not.toMatch(notPrepared)
    expect((await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })).isError).toBeFalsy()
    const r = await h.call('slicerx_slice', {})
    expect(text(r)).not.toMatch(notPrepared)
    expect(r.isError, text(r)).toBeFalsy()
  })

  it('queues a cloud slice on a machine profile and on a knowledge printer', async () => {
    const fetch = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      if (path === '/v1/access') return Response.json({ invited: true })
      if ((init.method ?? 'GET') === 'GET' && path.startsWith('/v1/meshes/')) return new Response(null, { status: 404 })
      if (init.method === 'PUT') return new Response(null, { status: 201 })
      return Response.json({ id: 'job-1', name: 'cube.stl', status: 'queued', progress: 0, stage: null, result: null, error: null, createdAt: '2026-10-31T00:00:00Z', finishedAt: null }, { status: 201 })
    }) as typeof globalThis.fetch
    const h = await connect({ cloud: { apiUrl: 'https://cloud.example.com', token: 'sxk_test', fetch } })
    for (const profiles of [['machine:prusa-mk4', 'process:standard'], ['printer:bambu_a1'], ['printer:bambu_a1', 'process:fine']]) {
      const r = await h.call('slicerx_cloud_slice', { model: join(h.dir, 'cube.stl'), profiles })
      expect(r.isError, `${profiles.join()} ${text(r)}`).toBeFalsy()
      expect(data<{ output: { jobId: string } }>(r).output.jobId).toBe('job-1')
    }
  })
})

