#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//
// Viewport frame-time benchmark.
// Builds the @slicerx/viewport demo, serves it, opens it in the installed
// Chrome, loads the reference plate and
// its preview, runs a scripted 10 s orbit and reports frame times from
// vp.stats(). The primary metric is p95 frame cost in Preview: the time from
// the start of render() until the GPU has finished that frame (a one-pixel
// readback after each frame). Frames run at the display rate (vsync on), so
// the GPU starts each frame idle and the cost is not hidden by pipelining.
// The rAF interval p95 is reported too; it is capped by vsync.
//
// Usage:
//   node apps/desktop/bench/viewport-orbit.mjs [--runs 3] [--scene preview|prepare|stress|all]
//        [--size 1280x800] [--dpr 2] [--headed] [--out result.json]
//        [--save-dist dir] [--baseline-dist dir --change "what changed" --log]
//   --save-dist copies the built demo so it can serve as the next baseline.
//   --baseline-dist runs that saved build interleaved with the current tree.
//   --candidate-dist uses a saved build as the candidate instead of building the tree.
//   --log appends one line to results.jsonl and one row to LOG.md next to this file.
//   With --baseline-dist, a change is kept when p95 improves by at least 2 percent and
//   the still frame matches the baseline's (mean channel difference at most 1.5;
//   pass --look-change for changes meant to alter the image). The first preview
//   frame time is logged as a gate value (goal: at most 50 ms).
//   Without --baseline-dist, --log records the run as a new baseline.
//   --feature logs a change made for image quality, not speed, so its cost is on record.
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = fileURLToPath(new URL('../../..', import.meta.url))
const pkg = join(root, 'packages/ui/viewport')
const req = createRequire(join(pkg, 'package.json'))

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const flag = (name) => args.includes(`--${name}`)
const runs = Number(opt('runs', 3))
const sceneArg = opt('scene', 'all')
const [cssW, cssH] = opt('size', '1280x800').split('x').map(Number)
const dpr = Number(opt('dpr', 2))
const orbitMs = Number(opt('ms', 10000))
const scenes = {
  preview: 'copies=1&mode=preview',
  prepare: 'copies=1&mode=prepare',
  stress: 'copies=9&mode=preview',
}
const selected = sceneArg === 'all' ? Object.keys(scenes) : sceneArg.split(',')

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  } catch {
    return ''
  }
}

async function buildDemo() {
  const { build } = await import(req.resolve('vite'))
  await build({ root: join(pkg, 'demo'), logLevel: 'warn', configFile: join(pkg, 'demo/vite.config.ts') })
  return join(pkg, 'demo/dist')
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.sxpv': 'application/octet-stream' }

function serve(dir) {
  return new Promise((resolve) => {
    const server = createServer((rq, rs) => {
      const url = new URL(rq.url ?? '/', 'http://x')
      const p = normalize(join(dir, url.pathname === '/' ? 'index.html' : url.pathname))
      if (!p.startsWith(dir) || !existsSync(p)) {
        rs.writeHead(404).end()
        return
      }
      rs.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : 0
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0
}

async function measure(browser, port, name, withStill) {
  const ctx = await browser.newContext({ viewport: { width: cssW, height: cssH }, deviceScaleFactor: dpr })
  try {
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.goto(`http://127.0.0.1:${port}/?bare=1&adaptive=0&pr=${dpr}&${scenes[name]}`)
    await page.waitForFunction(() => window.sxDemo !== undefined)
    await page.evaluate(() => window.sxDemo.ready)
    // Warm up: compile shaders, upload buffers, fill the shadow map.
    await page.evaluate(() => window.sxDemo.orbit(1500))
    const s = await page.evaluate((ms) => window.sxDemo.orbit(ms), orbitMs)
    if (errors.length) throw new Error(`page errors in ${name}: ${errors.join('; ')}`)
    if (/swiftshader|llvmpipe|software/i.test(s.gpu)) throw new Error(`software renderer (${s.gpu}); rerun with --headed`)
    if (s.costMs.length === 0) throw new Error('no frame timings')
    let still = null
    if (withStill) {
      await page.evaluate(() => window.sxDemo.vp.view('iso'))
      await page.waitForTimeout(300)
      still = (await page.locator('#vp').screenshot()).toString('base64')
    }
    return { gpu: s.gpu, p95: s.p95, p50: s.p50, frames: s.costMs.length, triangles: s.triangles, drawCalls: s.drawCalls, segments: s.segments, width: s.width, height: s.height, firstFrameMs: s.firstFrameMs, rafP95: pct(s.frameMs, 0.95), still }
  } finally {
    await ctx.close()
  }
}

function summarize(list) {
  const last = list[list.length - 1]
  const firsts = list.map((r) => r.firstFrameMs).filter((v) => v !== null)
  return { p95: median(list.map((r) => r.p95)), p50: median(list.map((r) => r.p50)), p95Runs: list.map((r) => r.p95), firstFrameMs: firsts.length ? median(firsts) : null, rafP95: median(list.map((r) => r.rafP95)), frames: last.frames, triangles: last.triangles, drawCalls: last.drawCalls, segments: last.segments, width: last.width, height: last.height }
}

async function main() {
  const candDist = opt('candidate-dist', null)
  const dist = candDist ?? (await buildDemo())
  const saveDist = opt('save-dist', null)
  if (saveDist) cpSync(dist, saveDist, { recursive: true })
  const baseDist = opt('baseline-dist', null)
  const servers = [await serve(dist)]
  if (baseDist) servers.push(await serve(baseDist))
  const variants = servers.map((sv, i) => ({ label: i === 0 ? 'candidate' : 'baseline', port: sv.address().port, runs: {}, still: null }))
  const { chromium } = req('playwright-core')
  const browser = await chromium.launch({ channel: 'chrome', headless: !flag('headed'), args: ['--ignore-gpu-blocklist', '--use-angle=metal'] })
  let gpu = ''
  try {
    for (const name of selected) {
      if (!scenes[name]) throw new Error(`unknown scene ${name}`)
      for (let r = 0; r < runs; r++) {
        // Interleave variants and flip their order each run so background load hits both evenly.
        const order = r % 2 === 0 ? variants : [...variants].reverse()
        for (const v of order) {
          const m = await measure(browser, v.port, name, name === 'preview' && r === 0)
          gpu = m.gpu
          if (m.still) v.still = m.still
          ;(v.runs[name] ??= []).push(m)
        }
      }
      for (const v of variants) {
        const x = summarize(v.runs[name])
        console.log(`${v.label.padEnd(9)} ${name.padEnd(8)} p95 ${x.p95.toFixed(2)} ms  p50 ${x.p50.toFixed(2)} ms  runs ${x.p95Runs.map((n) => n.toFixed(2)).join(', ')}  raf p95 ${x.rafP95.toFixed(2)}  first ${x.firstFrameMs === null ? 'n/a' : x.firstFrameMs.toFixed(1)} ms  ${x.triangles.toLocaleString('en-US')} tris  ${x.segments.toLocaleString('en-US')} segs  ${x.width}x${x.height}`)
      }
    }
  } finally {
    await browser.close()
    for (const sv of servers) sv.close()
  }

  const pack = (v) => ({ ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), gpu, cssSize: `${cssW}x${cssH}`, dpr, orbitMs, runs, scenes: Object.fromEntries(Object.entries(v.runs).map(([k, list]) => [k, summarize(list)])), still: v.still })
  const [cand, baseVar] = variants
  const result = pack(cand)
  const out = opt('out', null)
  if (out) writeFileSync(out, JSON.stringify(result))

  if (flag('log')) {
    // Without --baseline-dist the run is logged as a new baseline against itself.
    const base = baseVar ? pack(baseVar) : result
    const metricOf = (x) => x.scenes.preview?.p95 ?? x.scenes[Object.keys(x.scenes)[0]].p95
    const baseline = metricOf(base)
    const candidate = metricOf(result)
    const stillDiff = baseVar && base.still && result.still ? await imageDiff(base.still, result.still) : null
    const firstFrame = result.scenes.preview?.firstFrameMs ?? null
    const gates = { first_frame_ms: firstFrame, first_frame_ok: firstFrame === null || firstFrame <= 50, still_diff: stillDiff, still_ok: stillDiff === null || stillDiff <= 1.5 || flag('look-change') }
    // --feature records a quality change for the log; it is kept whatever it costs.
    const kept = flag('feature') || !baseVar ? true : candidate <= baseline * 0.98 && gates.still_ok
    const diff = createHash('sha256').update(git('diff -- packages/ui/viewport')).digest('hex').slice(0, 16)
    const line = {
      ts: result.ts,
      loop: 'viewport-orbit',
      machine: 'm5-mbp',
      gpu,
      base: git('rev-parse --short HEAD').trim() || null,
      diff,
      change: opt('change', ''),
      metric: 'p95_frame_ms',
      baseline: round(baseline),
      candidate: round(candidate),
      p50: round(result.scenes.preview?.p50 ?? 0),
      prepare_p95: round(result.scenes.prepare?.p95 ?? 0),
      stress_p95: round(result.scenes.stress?.p95 ?? 0),
      size: `${result.scenes.preview?.width ?? 0}x${result.scenes.preview?.height ?? 0}`,
      gates,
      kept,
    }
    appendFileSync(join(here, 'results.jsonl'), JSON.stringify(line) + '\n')
    const logPath = join(here, 'LOG.md')
    if (!existsSync(logPath)) {
      writeFileSync(
        logPath,
        '# Viewport frame-time hill-climb\n\nOne row per iteration of `viewport-orbit.mjs`. Metric: p95 frame cost in Preview during a 10 s scripted orbit of the reference plate at 1280x800 CSS and 2x (2560x1600 pixels). Frame cost is render() plus GPU completion, measured with a one-pixel readback after each frame. Baseline and candidate builds run interleaved in the same session. A change is kept when it improves p95 by at least 2 percent and the still frame is unchanged.\n\n| Time (UTC) | Change | Baseline p95 | Candidate p95 | Candidate p50 | Prepare p95 | Stress p95 | Gates | Kept |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n',
      )
    }
    const g = `first ${firstFrame === null ? 'n/a' : firstFrame.toFixed(1) + ' ms'}, still diff ${stillDiff === null ? 'n/a' : stillDiff.toFixed(2)}`
    appendFileSync(logPath, `| ${line.ts} | ${line.change} | ${line.baseline} | ${line.candidate} | ${line.p50} | ${line.prepare_p95} | ${line.stress_p95} | ${g} | ${kept ? 'yes' : 'no'} |\n`)
    console.log(`logged: baseline ${line.baseline} ms, candidate ${line.candidate} ms, kept ${kept}`)
  }
}

function round(v) {
  return Math.round(v * 100) / 100
}

/** Mean absolute channel difference (0 to 255) between two PNG screenshots, decoded in a blank Chrome page. */
async function imageDiff(a, b) {
  const { chromium } = req('playwright-core')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage()
    return await page.evaluate(
      async ([x, y]) => {
        const load = async (s) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob())
        const [ia, ib] = await Promise.all([load(x), load(y)])
        if (ia.width !== ib.width || ia.height !== ib.height) return 255
        const c = new OffscreenCanvas(ia.width, ia.height)
        const g = c.getContext('2d')
        g.drawImage(ia, 0, 0)
        const da = g.getImageData(0, 0, ia.width, ia.height).data
        g.clearRect(0, 0, ia.width, ia.height)
        g.drawImage(ib, 0, 0)
        const db = g.getImageData(0, 0, ib.width, ib.height).data
        let sum = 0
        for (let i = 0; i < da.length; i += 4) sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
        return sum / ((da.length / 4) * 3)
      },
      [a, b],
    )
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
