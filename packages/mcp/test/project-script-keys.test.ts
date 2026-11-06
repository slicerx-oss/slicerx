// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's printer G-code can name a setting SlicerX does not model, which the project itself carries. The engine
// renders a script from every key its config holds, and `sx slice <project.3mf>` slices with every key the file
// holds, so it renders the script. slicerx_slice_file builds its config from the imported settings, which leave the
// unknown key out: a script the slice keeps (here one the engine's stock review vouches for, as it does for a
// printer maker's own text) must still find the project's value for it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ScriptReview, ScriptReviewInput } from '@slicerx/contracts'
import { settingDef } from '@slicerx/settings'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'
import { KEY, scriptKeyProject, START } from './script-key-project'

const dir = mkdtempSync(join(tmpdir(), 'project-script-keys-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The fixture project, written to the test's folder. */
function p1sProject(): string {
  const path = join(dir, 'own-key.3mf')
  writeFileSync(path, scriptKeyProject())
  return path
}

/** The engine's stock review, answering that each script is the P1S maker's text. */
const vouched = async (inputs: ScriptReviewInput[]): Promise<ScriptReview[]> =>
  inputs.map(() => ({ schemaVersion: 1, decision: 'exact', reason: 'stock_match', identity: { model: 'bambu-p1s', firmware: 'marlin' }, source: 'test maker', stockVersion: '1.0', fingerprint: 'f'.repeat(32), ignored: [] }))

describe.skipIf(noSx())("a project's start G-code that reads a key SlicerX does not model", { timeout: sxTimeout }, () => {
  it('is a key the schema has no setting for', () => {
    expect(settingDef(KEY)).toBeUndefined()
  })

  it('renders with the project\'s value through sx slice <project.3mf>', () => {
    const file = p1sProject()
    const out = execFileSync(sxBin, ['slice', file, '-o', '-'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString()
    expect(out).toContain('M104 S187 ; hold')
  })

  it('renders with the project\'s value through slicerx_slice_file when the slice keeps the script', async () => {
    const file = p1sProject()
    const h = await connect({ engine: 'sx', sxBin, allowDirs: [dir] })
    try {
      h.ctx.slicer!.reviewScripts = vouched
      const r = await h.call('slicerx_slice_file', { model: file, plate: 1, project_settings: true, script_printer: { model: 'bambu-p1s', firmware: 'marlin' } })
      const out = data<{ gcode_path?: string; project_gcode?: { key: string; use: string }[]; error?: { message: string } }>(r)
      expect(r.isError, JSON.stringify(out)).toBeFalsy()
      expect(out.project_gcode).toContainEqual(expect.objectContaining({ key: 'machine_start_gcode', use: 'project' }))
      const gcode = readFileSync(out.gcode_path!, 'utf8')
      expect(gcode).toContain('M104 S187 ; hold')
      const request = JSON.parse(readFileSync(join(out.gcode_path!, '..', 'request.json'), 'utf8')) as { config: Record<string, unknown> }
      expect(request.config[KEY]).toEqual(['187'])
    } finally {
      await h.client.close()
    }
  })

  it('leaves the key out when the slice uses the printer profile\'s G-code instead', async () => {
    const file = p1sProject()
    const h = await connect({ engine: 'sx', sxBin, allowDirs: [dir] })
    try {
      const r = await h.call('slicerx_slice_file', { model: file, plate: 1, profiles: ['machine:bambu-p1s'], project_settings: true, project_gcode: 'profile' })
      const out = data<{ gcode_path?: string }>(r)
      expect(r.isError, JSON.stringify(out)).toBeFalsy()
      const request = JSON.parse(readFileSync(join(out.gcode_path!, '..', 'request.json'), 'utf8')) as { config: Record<string, unknown> }
      expect(request.config['machine_start_gcode']).not.toBe(START)
      expect(request.config[KEY]).toBeUndefined()
    } finally {
      await h.client.close()
    }
  })
})
