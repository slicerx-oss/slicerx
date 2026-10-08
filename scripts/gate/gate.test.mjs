// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The release gate's own rules, without an app: masking, bounded waits, the tower's G-code check, the upload model,
// the command line, the starter list against the starters the Vault is seeded with, and the report.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { coaster3mf } from './lib/coaster.mjs'
import { options } from './lib/options.mjs'
import { renderReport, runStatus } from './lib/report.mjs'
import { STARTERS, TOWER } from './lib/starters.mjs'
import { mask, temperatureChanges, towerCheck, waitUntil } from './lib/util.mjs'

const repo = join(import.meta.dirname, '..', '..')

describe('mask', () => {
  it('hides codes, tokens, keys and callbacks, and keeps the rest', () => {
    const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`
    const text = mask(
      `GET https://x.supabase.co/auth/v1/verify?token=abc123&type=magiclink ${jwt} Bearer s3cr3t slicerx://auth/callback?code=9f8e7d sb_publishable_AbC-12 ${'ab'.repeat(32)} qa-win@qa.slicerx.app`,
    )
    for (const secret of ['abc123', jwt, 's3cr3t', '9f8e7d', 'AbC-12', 'ab'.repeat(32)]) assert.ok(!text.includes(secret), secret)
    assert.match(text, /verify\?token=\[masked\]/)
    assert.match(text, /slicerx:\/\/auth\/callback\?\[masked\]/)
    assert.match(text, /qa-win@qa\.slicerx\.app/)
  })
})

describe('waitUntil', () => {
  it('returns the first answer', async () => {
    let n = 0
    const r = await waitUntil(() => (++n === 3 ? 'ok' : null), { timeoutMs: 1000, everyMs: 1 })
    assert.deepEqual([r.value, r.timedOut], ['ok', false])
  })
  it('gives up when the time runs out', async () => {
    const ticks = []
    const r = await waitUntil(() => null, { timeoutMs: 30, everyMs: 5, onWait: (ms) => ticks.push(ms) })
    assert.equal(r.timedOut, true)
    assert.ok(r.waitedMs >= 30)
    assert.ok(ticks.length > 0)
  })
})

describe('the temperature tower check', () => {
  // As an A1 profile writes it: the start G-code heats and cools at its own heights, the first layer sets its own
  // temperature, then come the tower's floors, then the end G-code turns the heater off.
  const START = ['G1 Z10', 'M104 S170', 'G1 Z5', 'M104 S140', 'M109 S140', 'G1 Z0.3', 'M104 S220 ; first layer']
  const gcode = (temps, extra = '', gap = 10) =>
    [...START, ...temps.flatMap((t, i) => [`G1 Z${(1 + i * gap).toFixed(2)}`, `M104 S${t} ; floor ${i + 1}`, 'G1 X10 Y10 E1']), extra, 'M104 S0'].join('\n')
  it('reads each change with its Z', () => {
    const t = temperatureChanges(gcode([230, 225]))
    assert.deepEqual(t.map((x) => [x.cmd, x.s, x.z]), [['M104', 170, 10], ['M104', 140, 5], ['M109', 140, 5], ['M104', 220, 0.3], ['M104', 230, 1], ['M104', 225, 11], ['M104', 0, 11]])
  })
  it('passes one M104 per floor at rising Z, after the start G-code', () => {
    const r = towerCheck(gcode(TOWER.temps), TOWER.temps, TOWER.floorMm)
    assert.equal(r.ok, true, r.why)
    assert.equal(r.floors.length, 7)
    assert.deepEqual(r.before.map((t) => t.s), [170, 140, 220])
  })
  it('fails a missing floor, a stray change or floors at the wrong height', () => {
    assert.equal(towerCheck(gcode(TOWER.temps.slice(0, 6)), TOWER.temps, TOWER.floorMm).ok, false)
    assert.equal(towerCheck(gcode(TOWER.temps, 'G1 Z80\nM104 S240'), TOWER.temps, TOWER.floorMm).ok, false)
    assert.match(towerCheck(gcode(TOWER.temps, '', 6), TOWER.temps, TOWER.floorMm).why, /apart/)
  })
})

/** The entries of a zip the gate wrote, inflated, with their CRCs checked by zlib. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const files = {}
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(at + 28)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    const size = buf.readUInt32LE(at + 20)
    const local = buf.readUInt32LE(at + 42)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    files[name] = inflateRawSync(buf.subarray(start, start + size)).toString('utf8')
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
  }
  return files
}

describe('the upload model', () => {
  it('is a two-part, two-color 3MF with no thumbnail, new each run', () => {
    const a = coaster3mf({ title: 'QA gate coaster <test>', seed: 1 })
    const b = coaster3mf({ title: 'QA gate coaster <test>', seed: 2 })
    const files = unzip(a.bytes)
    assert.deepEqual(Object.keys(files).sort(), ['3D/3dmodel.model', 'Metadata/model_settings.config', 'Metadata/project_settings.config', '[Content_Types].xml', '_rels/.rels'])
    assert.equal((files['3D/3dmodel.model'].match(/<mesh>/g) ?? []).length, 2)
    assert.match(files['3D/3dmodel.model'], /QA gate coaster &lt;test&gt;/)
    assert.match(files['Metadata/model_settings.config'], /name" value="Ring"\/><metadata key="extruder" value="2"/)
    assert.deepEqual(JSON.parse(files['Metadata/project_settings.config']).filament_colour, a.colors)
    assert.ok(!Object.keys(files).some((n) => /thumbnail|\.png$/i.test(n)))
    assert.notEqual(a.ringInnerMm, b.ringInnerMm)
    assert.notDeepEqual(a.bytes, b.bytes)
  })
})

describe('the command line', () => {
  it('runs every scenario by default and checks the account', () => {
    const o = options(['--account', 'QA-Win@qa.slicerx.app', '--platform', 'windows', '--out', 'x'])
    assert.deepEqual(o.run, ['a', 'b', 'c', 'd', 'e'])
    assert.equal(o.account, 'qa-win@qa.slicerx.app')
    assert.deepEqual([o.waitSignin, o.waitScan, o.waitReview], [10, 15, 60])
  })
  it('refuses addresses outside the qa domain, unknown scenarios and c or d without an account', () => {
    assert.throws(() => options(['--account', 'someone@slicerx.app']), /not a release-gate account/)
    assert.throws(() => options(['--account', 'qa@qa.slicerx.app.evil.com']), /not a release-gate account/)
    assert.throws(() => options(['--only', 'x']), /no scenario x/)
    assert.throws(() => options(['--only', 'c']), /need --account/)
    assert.throws(() => options(['--platform', 'amiga', '--only', 'a']), /windows, macos or linux/)
    assert.throws(() => options(['--only', 'e', '--starters', 'nope']), /no starter nope/)
  })
  it('runs a subset without an account', () => {
    const o = options(['--only', 'a,b,e', '--wait-signin', '1'])
    assert.deepEqual(o.run, ['a', 'b', 'e'])
    assert.equal(o.account, null)
    assert.deepEqual(options(['--skip', 'c,d']).run, ['a', 'b', 'e'])
  })
})

describe('the starters', () => {
  it('are the ones the Vault is seeded with, and the tower keeps its temperatures', () => {
    const src = readFileSync(join(repo, 'packages', 'app', 'scripts', 'starter-parts.ts'), 'utf8')
    const slugs = [...src.matchAll(/\bslug: '([a-z0-9-]+)'/g)].map((m) => m[1])
    assert.deepEqual([...STARTERS].sort(), ['x-mark', ...slugs].sort())
    const tower = /const TOWER_C = \[([^\]]+)\]/.exec(src)
    assert.deepEqual(tower?.[1].split(',').map((x) => Number(x.trim())), TOWER.temps)
    assert.equal(Number(/const FLOOR = (\d+(?:\.\d+)?)/.exec(src)?.[1]), TOWER.floorMm)
  })
})

describe('the report', () => {
  const run = (platform, status) => ({
    platform,
    commit: 'abc123',
    build: { file: 'slicerx.exe', sha256: 'f'.repeat(10) },
    startedAt: 't0',
    scenarios: [{ id: 'a', title: 'Vault <check>', status, steps: [{ name: 'covers', ok: status === 'PASS', detail: 'slicerx://auth/callback?code=leak' }], shots: [{ file: 'shots/a-01.png', caption: 'The Vault' }], console: ['[csp] Refused'], network: [], toasts: [] }],
  })
  it('shows every platform and scenario, escaped and masked', () => {
    const html = renderReport([run('windows', 'PASS'), run('linux', 'FAIL')], { prefix: (r) => `${r.platform}/` })
    assert.match(html, /<th>windows<\/th><th>linux<\/th>/)
    assert.match(html, /Vault &lt;check&gt;/)
    assert.match(html, /src="linux\/shots\/a-01.png"/)
    assert.ok(!html.includes('leak'))
    assert.match(html, /b-fail/)
  })
  it('fails a run with any failed scenario', () => {
    assert.equal(runStatus(run('windows', 'FAIL')), 'FAIL')
    assert.equal(runStatus(run('windows', 'PASS')), 'PASS')
  })
})
