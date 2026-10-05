#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packs the packages an app that builds SlicerX in installs (@slicerx/viewport, @slicerx/embed and
// @slicerx/mcp) into one folder, built, as npm would publish them, with the credit kit
// (docs/integrators/credit-kit) beside them. Use it until they are on npm:
//   node scripts/pack-integrator-kit.mjs ~/slicerx-kit
//   npm install ~/slicerx-kit/slicerx-viewport-0.1.0.tgz ~/slicerx-kit/slicerx-embed-0.1.0.tgz ~/slicerx-kit/slicerx-mcp-0.1.0.tgz
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dest = resolve(process.argv[2] ?? 'slicerx-kit')
const packages = ['@slicerx/viewport', '@slicerx/embed', '@slicerx/mcp']
mkdirSync(dest, { recursive: true })
for (const f of readdirSync(dest)) if (/^slicerx-(viewport|embed|mcp)-.*\.tgz$/.test(f)) rmSync(join(dest, f))
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
for (const p of packages) {
  // pack runs each package's prepack, which builds it.
  execFileSync(pnpm, ['--filter', p, 'pack', '--pack-destination', dest], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })
}
const files = readdirSync(dest).filter((f) => f.endsWith('.tgz')).sort((a, b) => order(a) - order(b))
function order(f) {
  return packages.findIndex((p) => f.startsWith(p.replace('@', '').replace('/', '-')))
}
// the credit kit is for people, so it sits beside the tarballs rather than in node_modules
const credit = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'integrators', 'credit-kit')
rmSync(join(dest, 'credit-kit'), { recursive: true, force: true })
cpSync(credit, join(dest, 'credit-kit'), { recursive: true })
console.log(`credit kit: ${join(dest, 'credit-kit')}`)
console.log(`npm install ${files.map((f) => join(dest, f)).join(' ')}`)
