// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A white-label edition (the Acme Slicer fixture) names itself in the server's tool text, results and errors, as a
// client sees them. The only SlicerX left is the cloud service's name in its setup text, and SlicerX's brand colors
// and X mark, which the make_model tool takes by name.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { productName, setProductName } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { editionNameFromEnv } from '../src/edition'
import { connect, text } from './helpers'

const ACME = resolve(__dirname, '../../edition-config/fixtures/acme/acme.json')
const acmeName = (JSON.parse(readFileSync(ACME, 'utf8')) as { brand: { name: string } }).brand.name

/** What may still say SlicerX: the cloud service's name, the brand colors and the X mark. */
const leftover = (s: string) =>
  s
    .replaceAll('the SlicerX cloud service', '')
    .replace(/SlicerX (black|white|purple|cyan|green|orange|yellow|red|X|logo)/g, '')
    .match(/.{0,60}SlicerX.{0,60}/g) ?? []

afterEach(() => setProductName('SlicerX'))

describe('a white-label edition over MCP', () => {
  it('reads its name from the resolved edition config SLICERX_CONFIG names', () => {
    expect(acmeName).toBe('Acme Slicer')
    expect(editionNameFromEnv({ SLICERX_CONFIG: ACME })).toBe('Acme Slicer')
    expect(editionNameFromEnv({})).toBeUndefined()
    expect(editionNameFromEnv({ SLICERX_CONFIG: '/nowhere/edition.json' })).toBeUndefined()
  })

  it('names itself in the instructions, every tool, its input schema and the resources', async () => {
    setProductName(acmeName)
    const h = await connect()
    const { tools } = await h.client.listTools()
    const { resourceTemplates } = await h.client.listResourceTemplates()
    const { resources } = await h.client.listResources()
    const all = [
      h.client.getInstructions() ?? '',
      ...tools.map((t) => JSON.stringify([t.title, t.description, t.inputSchema])),
      ...resourceTemplates.map((r) => JSON.stringify([r.title, r.description])),
      ...resources.filter((r) => !r.uri.startsWith('slicerx://knowledge/')).map((r) => JSON.stringify([r.title, r.description])),
    ].join('\n')
    expect(tools.length).toBeGreaterThan(50)
    expect(leftover(all)).toEqual([])
    expect(h.client.getInstructions()).toMatch(/^Acme Slicer, /)
    expect(tools.find((t) => t.name === 'slicerx_open_in_app')?.title).toBe('Open in the Acme Slicer app')
    expect(all).toContain('Acme Slicer print knowledge')
  })

  it('names itself in results and errors', async () => {
    setProductName(acmeName)
    const h = await connect()
    const profiles = text(await h.call('slicerx_list_profiles', { section: 'process', source: 'slicerx' }))
    expect(profiles).toContain('Acme Slicer default (Standard 0.20 mm, sleipnir, aegis walls)')
    await h.call('slicerx_project_open', { printer: 'bambu_p1s', filament: 'pla' })
    const wood = await h.call('slicerx_project_add_filament', { type: 'wood' })
    expect(wood.isError).toBe(true)
    expect(text(wood)).toMatch(/is not a filament type Acme Slicer knows/)
    const approve = await h.call('slicerx_approve', { request_id: 'nope', approve: true, bed_clear: true })
    expect(leftover(text(approve) + JSON.stringify(approve.content))).toEqual([])
  })

  it('names itself when the server runs on its own with SLICERX_CONFIG', async () => {
    expect(productName()).toBe('SlicerX')
    const run = promisify(execFile)
    const { stdout } = await run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--printers', 'off', 'call', 'project_open', '{"printer":"bambu_p1s","filament":"pla"}', 'project_add_filament', '{"type":"PLA"}', 'list_profiles', '{"section":"process","source":"slicerx"}'], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, SLICERX_CONFIG: ACME },
    })
    const out = stdout.trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean; text: string })
    expect(out.map((o) => o.ok)).toEqual([true, true, true])
    expect(out[2]!.text).toContain('Acme Slicer default')
    expect(leftover(stdout)).toEqual([])
  }, 60_000)
})
