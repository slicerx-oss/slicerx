// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Browser slice timing: serves packages/core/web/bench with Vite, opens it in
// Chrome through Playwright on fresh pages, and reports the median slice time
// (request to result) for the WASM worker pool.
//
//   node packages/core/bench/web-slice.mjs [--config <bench.json>] [--pages 9] [--workers N] [--per-worker N] [--append] [--change "..."]
//
// Build the module first: pnpm --filter @slicerx/slicer build:wasm
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const webDir = join(here, '..', 'web')
const require = createRequire(join(webDir, 'package.json'))
const { createServer } = await import(require.resolve('vite'))
const playwright = await import(require.resolve('playwright'))
const chromium = playwright.chromium ?? playwright.default.chromium

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const pages = Number(opt('--pages', '9'))
const configPath = opt('--config', 'packages/core/bench/configs/reference-0.20.json')
const benchConfig = JSON.parse(readFileSync(join(root, configPath), 'utf8'))
const workers = opt('--workers', '')
const perWorker = opt('--per-worker', '')

const server = await createServer({
  root: join(webDir, 'bench'),
  configFile: false,
  logLevel: 'error',
  server: { port: 0, fs: { allow: [root] } },
})
await server.listen()
const { port } = server.httpServer.address()
const fsUrl = (p) => `/@fs${join(root, p)}`
const url = `http://localhost:${port}/?model=${encodeURIComponent(fsUrl(benchConfig.model))}&config=${encodeURIComponent(fsUrl(configPath))}${workers ? `&workers=${workers}` : ''}${perWorker ? `&perWorker=${perWorker}` : ''}`

// --ab "<query A>" "<query B>" interleaves pages of two variants (extra
// query parameters such as perWorker=2) so load on this machine hits both.
const abIndex = args.indexOf('--ab')
const variants = abIndex >= 0 ? [args[abIndex + 1] ?? '', args[abIndex + 2] ?? ''] : ['']
const browser = await chromium.launch({ channel: process.env.SX_BROWSER_CHANNEL ?? 'chrome', headless: true })
const runs = variants.map(() => [])
try {
  // One unmeasured page per variant lets Vite finish its first transform.
  for (let i = 0; i < pages + 1; i++) {
    for (const [v, extra] of variants.entries()) {
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.goto(extra ? `${url}&${extra}` : url)
      await page.waitForFunction(() => window.sxBench !== undefined, null, { timeout: 120000 })
      const r = await page.evaluate(() => window.sxBench)
      await context.close()
      if (r.error) throw new Error(r.error)
      if (i > 0) runs[v].push(r)
    }
  }
} finally {
  await browser.close()
  await server.close()
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const round = (v) => Math.round(v * 10) / 10
const summary = (rs, extra) => ({
  variant: extra,
  pages: rs.length,
  workers: rs[0]?.workers,
  median_first_slice_ms: round(median(rs.map((r) => r.firstSliceMs))),
  median_warm_slice_ms: round(median(rs.map((r) => r.warmSliceMs))),
  median_pool_ms: round(median(rs.map((r) => r.poolMs))),
  median_load_ms: round(median(rs.map((r) => r.loadMs))),
  median_preview_ms: round(median(rs.map((r) => r.previewMs))),
  layers: rs[0]?.layers,
  gcode_sha256: rs[0]?.gcodeSha256,
  hashes_equal: rs.every((r) => r.gcodeSha256 === rs[0]?.gcodeSha256),
  shards_equal: rs.every((r) => r.shardsEqual),
  first_slice_ms: rs.map((r) => round(r.firstSliceMs)),
})
const results = runs.map((rs, v) => summary(rs, variants[v]))
const [base, cand] = results
const result =
  cand && base
    ? {
        baseline: base,
        candidate: cand,
        gain_pct: round(((base.median_first_slice_ms - cand.median_first_slice_ms) / base.median_first_slice_ms) * 100),
        gates_ok: cand.layers === benchConfig.expect_layers && cand.hashes_equal && cand.shards_equal && cand.gcode_sha256 === base.gcode_sha256,
      }
    : base
console.log(JSON.stringify(result, null, 2))
if (args.includes('--append')) {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const change = opt('--change', '')
  const kept = cand ? result.gates_ok && result.gain_pct >= 2 : null
  const entry = { ts, loop: 'browser-slice', machine: 'm5-macbook', change, metric: 'median_first_slice_ms', ...result, kept }
  appendFileSync(join(here, 'web-results.jsonl'), JSON.stringify(entry) + '\n')
  const logPath = join(here, 'WEB-LOG.md')
  if (!existsSync(logPath)) {
    writeFileSync(
      logPath,
      '# Browser slice hill-climb\n\nReference plate in Chrome on this Mac through the WASM worker pool, fresh page per run (`web-slice.mjs`). Metric: median first slice, request to result, ms. A/B rows interleave the two variants page by page.\n\n| Time (UTC) | Change | Baseline | Candidate | Gain % | Warm (candidate) | Workers | Same G-code | Kept |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n',
    )
  }
  const c = cand ?? base
  appendFileSync(
    logPath,
    `| ${ts} | ${change} | ${cand ? base.median_first_slice_ms : ''} | ${c.median_first_slice_ms} | ${cand ? result.gain_pct : ''} | ${c.median_warm_slice_ms} | ${c.workers} | ${c.hashes_equal && c.shards_equal ? 'yes' : 'no'} | ${kept === null ? '' : kept ? 'yes' : 'no'} |\n`,
  )
}
