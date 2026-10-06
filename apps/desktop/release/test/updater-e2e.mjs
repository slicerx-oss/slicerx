// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The in-app updater end to end with the real release scripts and the real updater, on a throwaway key:
//   node apps/desktop/release/test/updater-e2e.mjs
// Makes a key in a temporary folder, signs fake 0.2.0 bundles with sign-updates.sh, writes the feed with
// latest-json.mjs, serves it on 127.0.0.1 with a changed copy, a relabeled one (0.3.0 over 0.2.0's signature) and
// one at the running version, then runs src-tauri/tests/updater.rs against them. The key is deleted afterwards. It
// builds the desktop crate's tests, so run it where heavy builds run.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { latestJson, topNotes } from '../latest-json.mjs'

const here = import.meta.dirname
const desktop = resolve(here, '../..')
const repo = resolve(desktop, '../..')
const V = '0.2.0'
const NAMES = [`SlicerX_${V}_universal.app.tar.gz`, `SlicerX_${V}_x64-setup.exe`, `SlicerX_${V}_x64_en-US.msi`, `SlicerX_${V}_amd64.AppImage`, `SlicerX_${V}_amd64.deb`]
const FEEDS = ['good', 'tampered', 'relabeled', 'current']
const NOTES = { notes: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((note) => ({ note: `${note} change people will notice` })) }

const tmp = mkdtempSync(join(tmpdir(), 'sx-updater-e2e-'))
let server
let code = 1
try {
  // the throwaway key: no password, only its owner can read it
  mkdirSync(join(tmp, 'key'), { mode: 0o700 })
  const key = join(tmp, 'key', 'updater.key')
  execFileSync('pnpm', ['--silent', '--dir', desktop, 'exec', 'tauri', 'signer', 'generate', '--ci', '-w', key], { stdio: ['ignore', 'ignore', 'inherit'] })
  chmodSync(key, 0o600)
  const pubkey = readFileSync(`${key}.pub`, 'utf8').trim()

  const good = join(tmp, 'good')
  mkdirSync(good)
  for (const n of NAMES) writeFileSync(join(good, n), randomBytes(200_000))
  // sign-updates.sh, with a keychain item that does not exist so a real one on this machine is never read
  execFileSync('sh', [join(desktop, 'release', 'sign-updates.sh'), V, good], { stdio: 'inherit', env: { ...process.env, SX_UPDATER_KEY: key, SX_UPDATER_KEYCHAIN_ITEM: 'slicerx-updater-e2e-none' } })

  // the changed copy: the same signatures over different bytes
  const tampered = join(tmp, 'tampered')
  cpSync(good, tampered, { recursive: true })
  for (const n of NAMES) writeFileSync(join(tampered, n), randomBytes(200_000))

  server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^[/\\]+/, '')
    try {
      // the feeds and bundles only, never the key
      if (!FEEDS.includes(path.split(/[/\\]/)[0] ?? '')) throw new Error('not served')
      const body = readFileSync(join(tmp, path))
      res.writeHead(200, { 'content-length': body.length }).end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${server.address().port}`

  const sigs = (dir) => Object.fromEntries(readdirSync(dir).filter((f) => !f.endsWith('.sig')).map((f) => [f, readdirSync(dir).includes(`${f}.sig`) ? readFileSync(join(dir, `${f}.sig`), 'utf8') : null]))
  const feed = (dir, over = {}) => {
    const m = latestJson({ version: V, files: sigs(join(tmp, dir === 'tampered' ? 'tampered' : 'good')), baseUrl: `${base}/${dir === 'tampered' ? 'tampered' : 'good'}`, releaseUrl: `https://github.com/slicerx-oss/slicerx/releases/tag/desktop-v${V}`, pubkey, notes: topNotes(NOTES) })
    mkdirSync(join(tmp, dir), { recursive: true })
    writeFileSync(join(tmp, dir, 'latest.json'), JSON.stringify({ ...m, ...over }, null, 2))
  }
  feed('good')
  feed('tampered')
  feed('relabeled', { version: '0.3.0' })
  feed('current', { version: '0.1.0' })

  // not spawnSync: the feed is served from this process, which must keep answering while the test runs
  const run = spawn('cargo', ['test', '-p', 'slicerx-desktop', '--test', 'updater', '--', '--nocapture'], { cwd: repo, stdio: 'inherit', env: { ...process.env, SX_UPDATER_E2E: tmp, SX_UPDATER_E2E_URL: base } })
  code = await new Promise((done) => run.on('close', (c) => done(c ?? 1)))
} finally {
  server?.close()
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(code)
