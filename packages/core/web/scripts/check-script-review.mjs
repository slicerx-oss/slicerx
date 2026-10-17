// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// usage: node scripts/check-script-review.mjs <sx binary> <wasm file> [port]
const [sx, wasm, port = '5304'] = process.argv.slice(2)
if (!sx || !wasm) throw new Error('Pass a real sx binary and sx_wasm.wasm built from the same revision')
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const module = readFileSync(resolve(wasm))
const selected = { model: 'bambu-p1s', firmware: 'marlin' }
const base = { selected, declared: [selected], key: 'machine_pause_gcode', text: '  M400 U1 ; pause\r\n' }
const inputs = [
  base,
  { ...base, text: 'M400 U2' },
  { ...base, text: 'M400 U1\nM500' },
  { ...base, selected: null },
  { ...base, selected: { ...selected, firmware: 'unknown' } },
  { ...base, declared: [{ model: 'bambu-a1', firmware: 'marlin' }] },
  { ...base, text: '{if enabled}\nM400 U1' },
  { ...base, text: 'M400 U1 ; {"\\nM500"}' },
]
const native = JSON.parse(execFileSync(resolve(sx), ['review-script', '-', '--batch'], {
  input: JSON.stringify(inputs), encoding: 'utf8', timeout: 30000, windowsHide: true,
}))
const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: Number(port), strictPort: true },
  plugins: [{
    name: 'script-review-fixture',
    configureServer(server) {
      server.middlewares.use('/script-review.wasm', (_req, res) => {
        res.setHeader('Content-Type', 'application/wasm')
        res.end(module)
      })
    },
  }],
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/packages/core/web/test/script-review.html`)
  const actual = await page.evaluate(async (inputs) => (await window.reviewHostPromise).reviewScripts(inputs), inputs)
  assert.deepEqual(actual, native)
  assert.equal(actual[0].decision, 'cosmetic')
  for (const result of actual.slice(1)) assert.equal(result.decision, 'review')
  console.log(`${inputs.length} native/browser script review cases passed`)
} finally {
  await browser?.close()
  await server.close()
}
