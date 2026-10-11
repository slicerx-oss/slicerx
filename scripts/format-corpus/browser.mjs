// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's two 3MF readers in Chrome: the TypeScript scan and the geometry engine's format reader, each followed by the
// layout (scripts/format-corpus/browser/main.ts). Every file and reader gets a browser of its own, so the peak memory
// of its page (the renderer process's peak resident set, less that of a page that only fetched the file) is its own.
//
//   node scripts/format-corpus/browser.mjs [--private <dir>] [--repeats 3] [--min-kb 300]
//
// Build the engine first (packages/geom/wasm/scripts/build.sh). Linux only (the peak comes from /proc).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const require = createRequire(join(root, 'packages/core/web/package.json'))
const { createServer } = await import(require.resolve('vite'))
const playwright = await import(require.resolve('playwright'))
const chromium = playwright.chromium ?? playwright.default.chromium

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const repeats = Number(opt('--repeats', '3'))
const minKb = Number(opt('--min-kb', '300'))
const privateDir = opt('--private', process.env.SX_CORPUS_PRIVATE)

const manifest = JSON.parse(readFileSync(join(root, 'packages/geom/tests/corpus/corpus.json'), 'utf8'))
const files = manifest.files.map((f) => join(root, f.path)).filter((p) => /\.s?x?3mf$/i.test(p))
if (privateDir) files.push(...readdirSync(privateDir).filter((n) => /\.3mf$/i.test(n)).sort().map((n) => join(privateDir, n)))
const picked = files.filter((f) => statSync(f).size >= minKb * 1024)

const server = await createServer({ root: join(here, 'browser'), configFile: false, logLevel: 'error', server: { port: 0, fs: { allow: [root, ...(privateDir ? [privateDir] : [])] } } })
await server.listen()
const { port } = server.httpServer.address()

/** The renderer's peak resident set, KB. */
async function peakKb(browser) {
  const cdp = await browser.newBrowserCDPSession()
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
  let kb = 0
  for (const p of processInfo.filter((p) => p.type === 'renderer')) {
    try {
      kb = Math.max(kb, Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${p.id}/status`, 'utf8'))?.[1] ?? 0))
    } catch {
      // a renderer that has gone
    }
  }
  return kb
}

async function once(file, reader) {
  const browser = await chromium.launch({ headless: true, ...(process.env.SX_BROWSER_CHANNEL ? { channel: process.env.SX_BROWSER_CHANNEL } : {}) })
  try {
    const page = await browser.newPage()
    await page.goto(`http://localhost:${port}/?reader=${reader}&repeats=${repeats}&file=${encodeURIComponent(`/@fs${file}`)}`)
    await page.waitForFunction(() => window.sxBench !== undefined, null, { timeout: 600000 })
    const r = await page.evaluate(() => window.sxBench)
    return { ...r, kb: await peakKb(browser) }
  } finally {
    await browser.close()
  }
}

// one page first, so the module transforms are done before anything is timed
await once(picked[0] ?? files[0], 'ts')
console.log('| File | Size | Reader | First ms | Fastest ms | Peak MB | Objects | Parts |\n| --- | --- | --- | --- | --- | --- | --- | --- |')
for (const file of picked) {
  const base = await once(file, 'none')
  for (const reader of ['ts', 'geom']) {
    const r = await once(file, reader)
    const name = file.split('/').pop()
    const size = `${(statSync(file).size / 1024).toFixed(0)} KB`
    if (r.error) console.log(`| ${name} | ${size} | ${reader} | fails: ${r.error} | | | | |`)
    else console.log(`| ${name} | ${size} | ${reader} | ${r.times[0].toFixed(1)} | ${Math.min(...r.times).toFixed(1)} | ${((r.kb - base.kb) / 1024).toFixed(1)} | ${r.objects} | ${r.parts} |`)
  }
}
await server.close()
