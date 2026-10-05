#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dev kit's integration test. Copies this sample to a temporary folder, installs the SlicerX
// packages from tarballs packed the way npm publishes them, and checks every step of
// docs/integrators/quickstart.md from the outside: slicing over MCP, the error codes, the
// published types, the build, and the themed pieces in a headless browser.
//   SLICERX_SX_BIN=/path/to/sx node scripts/integration.mjs
// SPOOLHOUSE_KEEP=1 keeps the temporary folder. The locked project step runs only when
// SLICERX_MCP_SXLOCK_TOKEN, SLICERX_MCP_SUPABASE_URL and SLICERX_MCP_SUPABASE_ANON_KEY are set.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const sample = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(sample, '..', '..')
const win = process.platform === 'win32'
const npm = win ? 'npm.cmd' : 'npm'
const npx = win ? 'npx.cmd' : 'npx'
const sxBin = process.env['SLICERX_SX_BIN'] ?? join(repo, 'target', 'release', win ? 'sx.exe' : 'sx')
if (!existsSync(sxBin)) {
  console.error(`No sx engine at ${sxBin}. Build it with cargo build -p sx-cli --release, or set SLICERX_SX_BIN.`)
  process.exit(2)
}

const results = []
async function step(name, fn) {
  const t0 = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - t0 })
    console.log(`ok   ${name} (${Date.now() - t0} ms)`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0 })
    console.log(`FAIL ${name}\n${e instanceof Error ? e.stack ?? e.message : e}`)
    throw e
  }
}
function run(cmd, args, opts = {}) {
  try {
    // npm and npx are .cmd scripts on Windows, which need a shell; node itself must not get one (its path has a space).
    return execFileSync(cmd, args, { cwd: app, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', shell: win && cmd.endsWith('.cmd'), ...opts })
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout)
    throw e
  }
}

/** The entries of a zip file, stored or deflated. */
function unzip(buf) {
  const files = new Map()
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = buf.readUInt16LE(eocd + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extra = buf.readUInt16LE(p + 30)
    const comment = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + size)
    files.set(name, method === 8 ? inflateRawSync(raw) : raw)
    p += 46 + nameLen + extra + comment
  }
  return files
}

const app = mkdtempSync(join(tmpdir(), 'spoolhouse-'))
let failed = false
try {
  await step('copy the sample to a folder outside the repository', () => {
    for (const f of ['package.json', 'tsconfig.json', 'vite.config.ts', 'src', 'fixtures']) cpSync(join(sample, f), join(app, f), { recursive: true })
  })

  const kit = process.env['SPOOLHOUSE_KIT'] ?? join(app, '.kit')
  await step('pack @slicerx/viewport, @slicerx/embed and @slicerx/mcp as npm publishes them', () => {
    if (!process.env['SPOOLHOUSE_KIT']) execFileSync(process.execPath, [join(repo, 'scripts', 'pack-integrator-kit.mjs'), kit], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] })
    const tgz = readdirSync(kit).filter((f) => f.endsWith('.tgz'))
    assert.equal(tgz.length, 3, `three tarballs in ${kit}`)
    for (const [file, wants] of [['slicerx-embed', ['AGENTS.md', 'llms.txt']], ['slicerx-mcp', ['AGENTS.md', 'llms.txt']]]) {
      const t = tgz.find((f) => f.startsWith(file))
      const listing = execFileSync('tar', ['tzf', join(kit, t)], { encoding: 'utf8' })
      for (const w of wants) assert.match(listing, new RegExp(`package/${w.replace('.', '\\.')}`), `${t} ships ${w}`)
    }
  })

  await step('npm install the tarballs and the other dependencies', () => {
    const tgz = readdirSync(kit).filter((f) => f.endsWith('.tgz')).map((f) => join(kit, f))
    run(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tgz])
    run(npx, ['playwright', 'install', 'chromium'], { stdio: ['ignore', 'ignore', 'inherit'] })
  })

  let report
  await step('slice the plate with presets and a filament per slot over MCP (src/main/cli.ts)', () => {
    run(process.execPath, ['src/main/cli.ts'], { env: { ...process.env, SLICERX_SX_BIN: sxBin } })
    report = JSON.parse(readFileSync(join(app, 'out', 'report.json'), 'utf8'))
    assert.deepEqual(report.project.plates.map((p) => p.index), [1])
    const s = report.slice
    assert.equal(s.plate, 1)
    assert.equal(s.filaments.length, 2)
    assert.ok(s.filaments.every((f) => f.filament_g > 0), 'grams per slot')
    assert.ok(s.time_s > 0 && s.layer_count > 0)
    assert.deepEqual(s.applied, ['machine:bambu-a1', 'process:standard', 'slot 1: stock-filament:BBL/Bambu PLA Basic @BBL A1', 'slot 2: filament-file:My PETG'])
    assert.deepEqual(report.progress.map((p) => p.progress), [0, 0.1, 0.2, 0.9, 1])
  })

  await step('the .gcode.3mf has the plate, its thumbnail and both slots', () => {
    const zip = unzip(readFileSync(report.slice.gcode_3mf_path))
    const png = zip.get('Metadata/plate_1.png')
    assert.ok(png && png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'a PNG thumbnail')
    assert.ok(zip.get('Metadata/plate_1.gcode')?.length > 1000, 'the G-code')
    const info = zip.get('Metadata/slice_info.config')?.toString('utf8') ?? ''
    assert.match(info, /<filament id="1" tray_info_idx="" type="PLA" color="#F4EE2A"/)
    assert.match(info, /<filament id="2" tray_info_idx="" type="PETG" color="#00AE42"/)
    assert.ok(statSync(report.slice.preview_path).size > 1000, 'the SXPV preview')
  })

  await step('refusals carry stable error codes', () => {
    assert.deepEqual(report.errors, { 'missing plate': 'no_such_plate', 'outside the library': 'path_not_allowed', 'unknown profile': 'unknown_profile', 'bad setting': 'invalid_settings' })
    assert.equal(report.not_locked.code, 'not_sxlock')
  })

  await step(report.sxlock.skipped ? 'locked projects: skipped, no account token' : 'lock a project for the account and open it again (the account service at SLICERX_MCP_SUPABASE_URL)', () => {
    if (report.sxlock.skipped) return
    assert.equal(report.sxlock.same, true)
    assert.match(report.sxlock.owner, /^[0-9a-f-]{36}$/)
    assert.ok(report.sxlock.sliced_g > 0)
  })

  await step('typecheck against the published type declarations', () => {
    run(npx, ['tsc', '-p', 'tsconfig.json'])
  })

  await step('build the window with vite', () => {
    cpSync(join(sample, 'src', 'renderer'), join(app, 'src', 'renderer'), { recursive: true })
    run(npx, ['vite', 'build', '--logLevel', 'error'])
    assert.ok(existsSync(join(app, 'dist', 'index.html')))
    assert.ok(existsSync(join(app, 'dist', 'preview.sxpv')), 'the preview the main process handed over')
  })

  await step('the agreement, the viewport and the brand theme in a headless browser', async () => {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
    const server = createServer((req, res) => {
      const path = join(app, 'dist', decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.replace(/\/$/, '/index.html')))
      if (!path.startsWith(join(app, 'dist')) || !existsSync(path)) return void res.writeHead(404).end()
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path))
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
    const { chromium } = await import(pathToFileURL(join(app, 'node_modules', '@playwright', 'test', 'index.mjs')).href)
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : undefined))
      await page.goto(`http://127.0.0.1:${server.address().port}/`)
      const agreement = page.getByTestId('slicerx-agreement')
      await agreement.waitFor()
      const accent = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).getPropertyValue('--purple').trim())
      assert.equal(await accent('.sxe-agreement'), '#e8a33d', 'the agreement takes the brand accent')
      assert.equal(await page.getByRole('button', { name: 'Accept and continue' }).isDisabled(), true)
      await page.getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Accept and continue' }).click()
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('slicerx.embed.agreement') ?? 'null'))
      assert.equal(stored?.version, 1, 'acceptance is recorded with its version')
      await page.locator('.sxe-viewport canvas').waitFor()
      await page.getByTestId('slots').getByText('Slot 2').waitFor()
      assert.equal(await accent('.sxe-viewport'), '#e8a33d', 'the viewport takes the brand accent')
      assert.equal(await accent('.sxe-settings'), '#e8a33d', 'the settings panel takes the brand accent')
      const ink = await page.locator('.sxe-settings').evaluate((el) => getComputedStyle(el).backgroundColor)
      assert.equal(ink, 'rgb(29, 25, 21)', 'the settings panel takes the brand surface')
      await page.waitForTimeout(1500)
      // The 3D scene behind the plate is the brand's, not the default studio.
      const shot = await page.locator('.sxe-viewport canvas').screenshot()
      assert.ok(shot.length > 5000, 'the viewport drew a frame')
      await page.screenshot({ path: join(app, 'out', 'window-dark.png') })
      await page.getByTestId('scheme').click()
      assert.equal(await accent('.sxe-settings'), '#a8650f', 'the light brand theme applies at runtime')
      await page.waitForTimeout(1000)
      await page.screenshot({ path: join(app, 'out', 'window-light.png') })
      assert.deepEqual(errors, [], 'no errors in the page')
    } finally {
      await browser.close()
      server.close()
    }
  })
} catch {
  failed = true
} finally {
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed} of ${results.length} steps passed${failed ? ', stopped at the first failure' : ''}`)
  if (process.env['SPOOLHOUSE_KEEP']) console.log(`kept ${app}`)
  else rmSync(app, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
