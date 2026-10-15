// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportAssets, fallbacks, namespaceSvg, namespaceClasses, mergeSvgStyles } from './export-kit-assets.mjs'
import { TOOL_ICONS } from '../packages/ui/src/icons/tool-icons.ts'
import { DEMOS, SETTING_DEMOS } from '../packages/app/src/lib/demos.ts'

test('exports all registered tools, loops and setting mappings as self-contained files', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sx-kit-assets-'))
  try {
    const manifest = await exportAssets(out)
    for (const id of Object.keys(TOOL_ICONS)) for (const width of [16, 24, 32]) for (const theme of ['dark', 'light']) {
      assert.ok(manifest.assets.find((a) => a.kind === 'tool-icon' && a.id === id && a.size.width === width && a.theme === theme), `${id}/${width}/${theme}`)
    }
    for (const id of Object.keys(DEMOS)) for (const theme of ['dark', 'light']) assert.ok(manifest.assets.find((a) => a.kind === 'loop' && a.id === id && a.theme === theme), id)
    for (const [key, id] of Object.entries(SETTING_DEMOS)) assert.ok(manifest.assets.find((a) => a.kind === 'loop' && a.id === id && a.settingKey === key), key)
    const allIds = new Set()
    for (const file of new Set(manifest.assets.map((a) => a.file))) {
      const svg = readFileSync(join(out, file), 'utf8')
      assert.match(svg, /^<svg xmlns=/)
      assert.doesNotMatch(svg, /<script\b|<foreignObject\b|(?:href|src)="https?:/)
      assert.match(svg, /var\(--/)
      const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
      assert.equal(ids.length, new Set(ids).size, file)
      for (const id of ids) { assert.ok(!allIds.has(id), `Cross-file ID collision: ${id}`); allIds.add(id) }
      for (const m of svg.matchAll(/(?:url\(#|href="#)([^)"]+)/g)) assert.ok(ids.includes(m[1]), `${file}: ${m[1]}`)
    }
    const push = readFileSync(join(out, 'loops/dark/push.svg'), 'utf8')
    assert.match(push, /@keyframes loop-push-dark-296-/)
    assert.match(push, /prefers-reduced-motion/)
    assert.match(push, /var\(--accent,#bd93f9\)/)
    // a filled part in currentColor takes the accent, not black, in an isolated image
    assert.match(readFileSync(join(out, 'icons/dark/step-broken-24.svg'), 'utf8'), /style="color:var\(--accent,#bd93f9\)"/)
    assert.match(readFileSync(join(out, 'tokens.css'), 'utf8'), /\[data-sx-theme="light"\]/)
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('nested fallbacks preserve overrides and reject missing or cyclic tokens', () => {
  assert.equal(fallbacks('fill:var(--shade)', { '--shade': 'var(--accent)', '--accent': '#123456' }), 'fill:var(--shade,var(--accent,#123456))')
  assert.throws(() => fallbacks('var(--absent)', {}), /Missing default/)
  assert.throws(() => fallbacks('var(--a)', { '--a': 'var(--a)' }), /Circular/)
  assert.equal(namespaceSvg('<g id="a"/><use href="#a"/><path fill="url(#a)"/>', 'one'), '<g id="one-a"/><use href="#one-a"/><path fill="url(#one-a)"/>')
})

test('asset classes isolate rules without adding ancestry to use-clone styles', () => {
  const input = '<style>.sxs-rows text{fill:white}.sxs-rows .sxs-cut{fill:red}.sxs-ptr{stroke:black}:where(.sxs .s-a){opacity:1}</style><g class="sxs-rows"><text class="sxs-cut"/></g><path class="sxs-ptr s-a"/>'
  const out = namespaceClasses(input, 'push-dark', 'sxs')
  assert.match(out, /\.push-dark-sxs-rows text\{fill:white\}/)
  assert.match(out, /\.push-dark-sxs-rows \.push-dark-sxs-cut\{fill:red\}/)
  assert.match(out, /\.push-dark-sxs-ptr\{stroke:black\}/)
  assert.match(out, /:where\(\.push-dark-sxs \.push-dark-s-a\)/)
  assert.match(out, /class="sxs-ptr s-a push-dark-sxs-ptr push-dark-s-a"/)
  assert.doesNotMatch(out, /svg\[/)
})

test('the packaging CLI includes assets without building packages', () => {
  const out = mkdtempSync(join(tmpdir(), 'sx-kit-assets-cli-'))
  try {
    execFileSync(process.execPath, ['scripts/pack-integrator-kit.mjs', out, '--assets-only'])
    const manifest = JSON.parse(readFileSync(join(out, 'assets/manifest.json'), 'utf8'))
    assert.ok(manifest.assets.some((a) => a.id === 'push' && a.kind === 'loop'))
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('stage paint and line-cap styles form one XML attribute', () => {
  assert.equal(mergeSvgStyles('<path style="stroke:red;stroke-width:4" style="stroke-linecap:round" d="M0 0h0"/>'), '<path style="stroke:red;stroke-width:4;stroke-linecap:round;" d="M0 0h0"/>')
  assert.equal(mergeSvgStyles('<path style="fill:none"/>'), '<path style="fill:none"/>')
})
